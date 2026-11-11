#!/usr/bin/env python3
"""Token-aware AS3 corpus scanner (Phase 1 reconnaissance).

This is NOT a compiler frontend: it performs a lexical scan that respects
comments, strings and regex literals, then extracts package/class/interface
structure, imports, metadata and coarse language-feature statistics.

The output is used to write docs/PROJECT_PROFILE.md and to prioritise runtime
work. Every number in the profile must be reproducible with:

    python3 tools/corpus_scan.py <as3-src-root> --out build/corpus-profile.json
"""
from __future__ import annotations

import argparse
import json
import re
from collections import Counter, defaultdict
from pathlib import Path

# ---------------------------------------------------------------------------
# Lexer (lightweight but comment/string/regex aware)
# ---------------------------------------------------------------------------

MULTI_PUNCT = [
    ">>>=", "===", "!==", ">>>", "<<=", ">>=", "...", "::", "..",
    "==", "!=", "<=", ">=", "&&", "||", "++", "--", "+=", "-=", "*=",
    "/=", "%=", "&=", "|=", "^=", "<<", ">>",
]
ID_START = set("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ_$")
ID_PART = ID_START | set("0123456789")

REGEX_PRECEDERS = set(
    "= ( [ { , ; : ! & | ? + - * % ^ ~ < >".split()
) | {"return", "case", "in", "of", "typeof", "new", "delete", "void", "throw"}


class Token:
    __slots__ = ("kind", "text", "line", "col", "start", "end")

    def __init__(self, kind, text, line, col, start, end):
        self.kind = kind      # id | num | str | punct
        self.text = text
        self.line = line
        self.col = col
        self.start = start
        self.end = end

    def __repr__(self):
        return f"Token({self.kind},{self.text!r},L{self.line})"


def tokenize(src: str) -> list[Token]:
    toks: list[Token] = []
    i, n = 0, len(src)
    line, line_start = 1, 0
    prev_sig: Token | None = None

    def emit(kind, start, end):
        nonlocal prev_sig
        t = Token(kind, src[start:end], line, start - line_start + 1, start, end)
        toks.append(t)
        prev_sig = t
        return t

    while i < n:
        c = src[i]
        if c == "\n":
            line += 1
            i += 1
            line_start = i
            continue
        if c in " \t\r\f\v\ufeff":
            i += 1
            continue
        if c == "/" and i + 1 < n and src[i + 1] == "/":
            j = src.find("\n", i)
            i = n if j < 0 else j
            continue
        if c == "/" and i + 1 < n and src[i + 1] == "*":
            j = src.find("*/", i + 2)
            j = n if j < 0 else j + 2
            line += src.count("\n", i, j)
            nl = src.rfind("\n", i, j)
            if nl >= 0:
                line_start = nl + 1
            i = j
            continue
        if c in "\"'":
            q = c
            j = i + 1
            while j < n:
                if src[j] == "\\":
                    j += 2
                    continue
                if src[j] == q:
                    j += 1
                    break
                if src[j] == "\n":
                    line += 1
                    line_start = j + 1
                j += 1
            emit("str", i, min(j, n))
            i = min(j, n)
            continue
        # Regex literal: '/' in expression position, not comment.
        if c == "/" and prev_sig is not None and (
            prev_sig.text in REGEX_PRECEDERS or prev_sig.kind == "punct"
            and prev_sig.text in REGEX_PRECEDERS
        ):
            j = i + 1
            in_class = False
            closed = False
            while j < n:
                ch = src[j]
                if ch == "\\":
                    j += 2
                    continue
                if ch == "[":
                    in_class = True
                elif ch == "]":
                    in_class = False
                elif ch == "/" and not in_class:
                    j += 1
                    while j < n and src[j] in ID_PART:
                        j += 1
                    closed = True
                    break
                elif ch == "\n":
                    break
                j += 1
            if closed:
                emit("str", i, j)
                i = j
                continue
        if c.isdigit() or (c == "." and i + 1 < n and src[i + 1].isdigit()):
            j = i
            if src.startswith(("0x", "0X"), i):
                j = i + 2
                while j < n and (src[j] in "0123456789abcdefABCDEF"):
                    j += 1
            else:
                while j < n and (src[j].isdigit() or src[j] == "."):
                    j += 1
                if j < n and src[j] in "eE":
                    k = j + 1
                    if k < n and src[k] in "+-":
                        k += 1
                    if k < n and src[k].isdigit():
                        j = k
                        while j < n and src[j].isdigit():
                            j += 1
            emit("num", i, j)
            i = j
            continue
        if c in ID_START:
            j = i + 1
            while j < n and src[j] in ID_PART:
                j += 1
            emit("id", i, j)
            i = j
            continue
        matched = False
        for p in MULTI_PUNCT:
            if src.startswith(p, i):
                emit("punct", i, i + len(p))
                i += len(p)
                matched = True
                break
        if matched:
            continue
        emit("punct", i, i + 1)
        i += 1
    return toks


# ---------------------------------------------------------------------------
# Structural scanning
# ---------------------------------------------------------------------------

MODIFIERS = {
    "public", "private", "protected", "internal", "static", "final",
    "dynamic", "override", "native", "virtual", "const", "var", "function",
}
DECL_STOP = {";", "{", "}", "(", ")", ","}


def qualified(toks, i):
    """Read a dotted name starting at i. Returns (name, next_index)."""
    parts = []
    while i < len(toks) and toks[i].kind == "id":
        parts.append(toks[i].text)
        i += 1
        if i < len(toks) and toks[i].text == "." and i + 1 < len(toks) and toks[i + 1].kind == "id":
            i += 1
            continue
        break
    return ".".join(parts), i


def scan_file(path: Path, root: Path):
    raw = path.read_text(encoding="utf-8", errors="replace")
    toks = tokenize(raw)
    rec = {
        "file": str(path.relative_to(root)),
        "lines": raw.count("\n") + (1 if raw else 0),
        "bytes": len(raw.encode("utf-8")),
        "package": "",
        "imports": [],
        "declarations": [],   # classes + interfaces, with members
        "metadata": [],
        "top_level_functions": 0,
        "feature": Counter(),
        "type_refs": Counter(),
        "identifiers": Counter(),
        "qualified_refs": Counter(),
    }
    if not toks:
        return rec, toks

    depth = 0
    i = 0
    pkg_depth = None
    decl_depth = None
    current = None

    while i < len(toks):
        t = toks[i]
        text = t.text

        # package declaration
        if text == "package" and pkg_depth is None and depth == 0:
            j = i + 1
            pkg = ""
            if j < len(toks) and toks[j].kind == "id":
                pkg, j = qualified(toks, j)
            rec["package"] = pkg
            while j < len(toks) and toks[j].text != "{":
                j += 1
            if j < len(toks):
                depth += 1
                pkg_depth = depth
                i = j + 1
                continue
            i = j
            continue

        if text == "{":
            depth += 1
            i += 1
            continue
        if text == "}":
            depth -= 1
            if decl_depth is not None and depth < decl_depth:
                decl_depth = None
                current = None
            if pkg_depth is not None and depth < pkg_depth:
                pkg_depth = None
            i += 1
            continue

        # imports (outside class bodies)
        if text == "import" and depth <= 1:
            j = i + 1
            name = ""
            while j < len(toks) and toks[j].text != ";":
                if toks[j].kind in ("id", "punct"):
                    name += toks[j].text
                j += 1
            rec["imports"].append(name)
            i = j + 1
            continue

        # metadata blocks at declaration level
        if text == "[" and depth in (1, 2):
            j = i + 1
            if j < len(toks) and toks[j].kind == "id":
                meta_name = toks[j].text
                depth_inner = 1
                k = j + 1
                while k < len(toks) and depth_inner > 0:
                    if toks[k].text == "[":
                        depth_inner += 1
                    elif toks[k].text == "]":
                        depth_inner -= 1
                    k += 1
                raw_meta = raw[t.start:toks[k - 1].end] if k - 1 < len(toks) else ""
                rec["metadata"].append({"name": meta_name, "raw": raw_meta, "line": t.line})
                i = k
                continue

        # class / interface declarations
        if text in ("class", "interface") and depth == 1:
            j = i + 1
            modifiers = []
            k = i - 1
            while k >= 0 and toks[k].text not in (";", "{", "}", "]", "package"):
                modifiers.append(toks[k].text)
                k -= 1
            modifiers.reverse()
            name = ""
            if j < len(toks) and toks[j].kind == "id":
                name = toks[j].text
                j += 1
            decl = {
                "kind": text,
                "name": name,
                "fqcn": f"{rec['package']}.{name}" if rec["package"] else name,
                "modifiers": [m for m in modifiers if m in MODIFIERS],
                "extends": None,
                "implements": [],
                "members": [],
                "line": t.line,
            }
            # header up to '{'
            while j < len(toks) and toks[j].text != "{":
                if toks[j].text == "extends":
                    nm, j = qualified(toks, j + 1)
                    if text == "interface":
                        decl.setdefault("extends_list", []).append(nm)
                    else:
                        decl["extends"] = nm
                    continue
                if toks[j].text == "implements":
                    j += 1
                    while j < len(toks) and toks[j].text != "{":
                        if toks[j].kind == "id":
                            decl["implements"].append(toks[j].text)
                        j += 1
                    continue
                j += 1
            if j < len(toks) and toks[j].text == "{":
                depth += 1
                decl_depth = depth
                current = decl
                rec["declarations"].append(decl)
                i = j + 1
                continue
            i = j
            continue

        # members directly inside a class body
        if current is not None and decl_depth is not None and depth == decl_depth:
            if text in ("var", "const") and i + 1 < len(toks) and toks[i + 1].kind == "id":
                name = toks[i + 1].text
                j = i + 2
                typ = None
                if j < len(toks) and toks[j].text == ":":
                    typ, j = qualified(toks, j + 1)
                if typ:
                    rec["type_refs"][typ.split(".")[-1]] += 1
                current["members"].append({
                    "kind": text, "name": name, "type": typ,
                    "line": toks[i].line,
                })
                i = j
                continue
            if text == "function":
                j = i + 1
                accessor = None
                if j < len(toks) and toks[j].text in ("get", "set"):
                    accessor = toks[j].text
                    j += 1
                if j < len(toks) and toks[j].kind == "id":
                    name = toks[j].text
                    j += 1
                    params = []
                    if j < len(toks) and toks[j].text == "(":
                        close = j
                        paren = 0
                        while close < len(toks):
                            if toks[close].text == "(":
                                paren += 1
                            elif toks[close].text == ")":
                                paren -= 1
                                if paren == 0:
                                    break
                            close += 1
                        # parameter list: name : Type = default
                        seg = toks[j + 1:close]
                        k = 0
                        while k < len(seg):
                            if seg[k].text == "...":
                                params.append({"rest": True, "name": seg[k + 1].text if k + 1 < len(seg) else ""})
                                break
                            if seg[k].kind == "id" and not (k + 1 < len(seg) and seg[k + 1].text == ":"):
                                pname = seg[k].text
                                ptyp = None
                                default = False
                                m = k + 1
                                if m < len(seg) and seg[m].text == ":":
                                    ptyp, m = qualified(seg, m + 1)
                                    if ptyp:
                                        rec["type_refs"][ptyp.split(".")[-1]] += 1
                                while m < len(seg) and seg[m].text != ",":
                                    if seg[m].text == "=":
                                        default = True
                                    m += 1
                                params.append({"name": pname, "type": ptyp, "default": default})
                                k = m + 1
                                continue
                            k += 1
                        j = close + 1
                    ret = None
                    if j < len(toks) and toks[j].text == ":":
                        ret, j = qualified(toks, j + 1)
                        if ret:
                            rec["type_refs"][ret.split(".")[-1]] += 1
                    current["members"].append({
                        "kind": "accessor" if accessor else (
                            "constructor" if name == current["name"] else "method"
                        ),
                        "accessor": accessor,
                        "name": name,
                        "params": params,
                        "return_type": ret,
                        "line": toks[i].line,
                    })
                    if accessor:
                        rec["feature"][accessor] += 1
                    i = j
                    continue

        # top-level (non-member) functions
        if text == "function" and depth == 1 and current is None:
            rec["top_level_functions"] += 1

        # token-level language feature accounting
        if t.kind == "id":
            rec["identifiers"][text] += 1
            if text in ("for",) and i + 1 < len(toks) and toks[i + 1].text == "each":
                rec["feature"]["for_each"] += 1
            if text == "for":
                # for (x in y) / for each (x in y)
                k = i + 1
                if k < len(toks) and toks[k].text == "each":
                    k += 1
                if k < len(toks) and toks[k].text == "(":
                    depth_p = 0
                    end = k
                    while end < len(toks):
                        if toks[end].text == "(":
                            depth_p += 1
                        elif toks[end].text == ")":
                            depth_p -= 1
                            if depth_p == 0:
                                break
                        end += 1
                    window = [x.text for x in toks[k:end]]
                    if "in" in window:
                        rec["feature"]["for_in"] += 1
            if text == "dynamic" and i + 1 < len(toks) and toks[i + 1].text == "class":
                rec["feature"]["dynamic_class"] += 1
            if text == "final" and i + 1 < len(toks) and toks[i + 1].text == "class":
                rec["feature"]["final_class"] += 1
            if text == "use" and i + 1 < len(toks) and toks[i + 1].text == "namespace":
                rec["feature"]["use_namespace"] += 1
            if text == "namespace" and depth >= 1:
                rec["feature"]["namespace_decl"] += 1
            if text == "with":
                rec["feature"]["with"] += 1
            if text == "include":
                rec["feature"]["include"] += 1
            if text == "describeType":
                rec["feature"]["describeType"] += 1
            if text == "getDefinitionByName":
                rec["feature"]["getDefinitionByName"] += 1
            if text == "is":
                rec["feature"]["is"] += 1
            if text == "as":
                rec["feature"]["as"] += 1
            if text == "typeof":
                rec["feature"]["typeof"] += 1
            if text == "delete":
                rec["feature"]["delete"] += 1
            if text == "throw":
                rec["feature"]["throw"] += 1
            if text == "try":
                rec["feature"]["try"] += 1
            if text == "switch":
                rec["feature"]["switch"] += 1
            if text == "arguments":
                rec["feature"]["arguments"] += 1
            if text == "super":
                rec["feature"]["super"] += 1
            if text == "this":
                rec["feature"]["this"] += 1
            if text == "Vector":
                rec["feature"]["vector_mention"] += 1
                if (i + 2 < len(toks) and toks[i + 1].text == "." and toks[i + 2].text == "<"):
                    rec["feature"]["vector_typed"] += 1
            # fully qualified platform references in code: flash.foo.Bar
            if text in ("flash", "mx", "__AS3__", "air") and i + 3 < len(toks):
                j = i
                parts = []
                while j + 1 < len(toks) and toks[j].kind == "id" and toks[j + 1].text == ".":
                    parts.append(toks[j].text)
                    j += 2
                if j < len(toks) and toks[j].kind == "id":
                    parts.append(toks[j].text)
                if len(parts) >= 3:
                    rec["qualified_refs"][".".join(parts)] += 1
        elif t.kind == "punct":
            if text == "::":
                rec["feature"]["qualifier_scope"] += 1
            if text == "..":
                rec["feature"]["descendant_operator"] += 1
            if text == "...":
                rec["feature"]["rest_param"] += 1
        i += 1

    # type reference heuristic: ': Type' and 'function():Type' already handled
    return rec, toks


# ---------------------------------------------------------------------------
# Project-wide analysis
# ---------------------------------------------------------------------------

def tarjan(nodes, adj):
    """Return strongly connected components."""
    index = {}
    low = {}
    stack = []
    on_stack = set()
    result = []
    counter = [0]

    def strong(v):
        index[v] = low[v] = counter[0]
        counter[0] += 1
        stack.append(v)
        on_stack.add(v)
        for w in adj.get(v, ()):
            if w not in index:
                strong(w)
                low[v] = min(low[v], low[w])
            elif w in on_stack:
                low[v] = min(low[v], index[w])
        if low[v] == index[v]:
            comp = []
            while True:
                w = stack.pop()
                on_stack.discard(w)
                comp.append(w)
                if w == v:
                    break
            result.append(comp)

    for v in nodes:
        if v not in index:
            strong(v)
    return result


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("root", type=Path)
    ap.add_argument("--out", type=Path, default=Path("build/corpus-profile.json"))
    args = ap.parse_args()

    root = args.root.resolve()
    files = sorted(root.rglob("*.as"))
    records = []
    for n, p in enumerate(files):
        rec, _toks = scan_file(p, root)
        records.append(rec)
        if (n + 1) % 1000 == 0:
            print(f"  scanned {n + 1}/{len(files)} files", flush=True)

    # --- declarations ------------------------------------------------------
    local = {}          # fqcn -> declaration
    duplicates = defaultdict(list)
    packages = set()
    per_file_decls = {}
    for rec in records:
        if rec["package"]:
            packages.add(rec["package"])
        for d in rec["declarations"]:
            if d["fqcn"] in local:
                duplicates[d["fqcn"]].append(rec["file"])
            else:
                local[d["fqcn"]] = {"decl": d, "file": rec["file"]}
        per_file_decls[rec["file"]] = [d["fqcn"] for d in rec["declarations"]]

    for rec in records:
        for d in rec["declarations"]:
            duplicates[d["fqcn"]].append(rec["file"])
    duplicates = {k: sorted(set(v)) for k, v in duplicates.items() if len(set(v)) > 1}

    # --- imports -----------------------------------------------------------
    import_counts = Counter()
    external_imports = Counter()
    unresolved = Counter()
    flash_classes = Counter()
    flash_files = Counter()
    internal_edges = defaultdict(set)

    def resolve_import(name, rec):
        if name.endswith(".*"):
            return ("package", name[:-2])
        if name in local:
            return ("class", name)
        # fully qualified but not declared locally
        if "." in name:
            return ("external", name)
        # bare name: same package, then imports
        same = f"{rec['package']}.{name}" if rec["package"] else name
        if same in local:
            return ("class", same)
        for imp in rec["imports"]:
            if imp.endswith("." + name):
                return resolve_import(imp, {"package": "", "imports": []})
        return ("unresolved", name)

    for rec in records:
        for imp in rec["imports"]:
            import_counts[imp] += 1
            kind, target = resolve_import(imp, rec)
            if kind == "class":
                for fq in per_file_decls.get(rec["file"], []):
                    internal_edges[fq].add(target)
            elif kind == "package":
                if target in packages:
                    for fq in per_file_decls.get(rec["file"], []):
                        internal_edges[fq].add(target)
                else:
                    external_imports[imp] += 1
            elif kind == "external":
                external_imports[imp] += 1
            else:
                unresolved[imp] += 1
            if imp.startswith("flash.") or imp.startswith("air."):
                if not imp.endswith(".*"):
                    flash_classes[imp] += 1
                    flash_files[imp] = flash_files.get(imp, 0) + 1

    # Inline fully-qualified flash references
    inline_flash = Counter()
    for rec in records:
        for q, c in rec["qualified_refs"].items():
            if q.startswith(("flash.", "air.")):
                inline_flash[q] += c

    # --- reference counts for imported platform classes --------------------
    flash_refs = Counter()
    for rec in records:
        ids = rec["identifiers"]
        for imp in rec["imports"]:
            if imp.startswith(("flash.", "air.", "mx.")) and not imp.endswith(".*"):
                simple = imp.rsplit(".", 1)[-1]
                flash_refs[imp] += ids.get(simple, 0)

    # --- inheritance -------------------------------------------------------
    def resolve_type(name, rec):
        if not name:
            return None
        if name in local:
            return name
        if "." in name:
            return None
        for imp in rec["imports"]:
            if imp.endswith("." + name):
                return imp
        same = f"{rec['package']}.{name}" if rec["package"] else name
        if same in local:
            return same
        return None

    base_counts = Counter()
    unresolved_bases = Counter()
    local_children = defaultdict(list)
    class_rec = {d["fqcn"]: (rec, d) for rec in records for d in rec["declarations"]}

    for fq, (rec, d) in class_rec.items():
        if d["kind"] != "class":
            continue
        base = d["extends"]
        if not base:
            base_counts["(none)"] += 1
            continue
        resolved = resolve_type(base, rec)
        base_counts[base.split(".")[-1]] += 1
        if resolved:
            local_children[resolved].append(fq)
        else:
            unresolved_bases[base] += 1
        for itf in d["implements"]:
            if not resolve_type(itf, rec):
                unresolved_bases[itf] += 1

    depth_cache = {}
    cycle_nodes = set()

    def depth(fq, seen=()):
        if fq in depth_cache:
            return depth_cache[fq]
        if fq in seen:
            cycle_nodes.update(seen)
            return 1
        d = class_rec.get(fq, (None, None))[1]
        base = d["extends"] if d else None
        rec = class_rec.get(fq, (None, None))[0]
        r = resolve_type(base, rec) if base and rec else None
        val = 1 + depth(r, seen + (fq,)) if r else 1
        depth_cache[fq] = val
        return val

    for fq in class_rec:
        depth(fq)

    # --- language feature totals ------------------------------------------
    feature = Counter()
    for rec in records:
        for k, v in rec["feature"].items():
            feature[k] += v

    type_refs = Counter()
    for rec in records:
        for k, v in rec["type_refs"].items():
            type_refs[k] += v

    # --- embedded assets ---------------------------------------------------
    embeds = []
    extensions = Counter()
    mimes = Counter()
    for rec in records:
        for m in rec["metadata"]:
            if m["name"] != "Embed":
                continue
            src = re.search(r'source\s*=\s*"([^"]+)"', m["raw"])
            mime = re.search(r'mimeType\s*=\s*"([^"]+)"', m["raw"])
            fn = src.group(1) if src else None
            embeds.append({"file": rec["file"], "source": fn, "mime": mime.group(1) if mime else None})
            if fn:
                ext = Path(fn).suffix.lower().lstrip(".")
                extensions[ext] += 1
            if mime:
                mimes[mime.group(1)] += 1

    # --- members -----------------------------------------------------------
    member_kinds = Counter()
    accessor_names = Counter()
    method_param_counts = Counter()
    for rec in records:
        for d in rec["declarations"]:
            for m in d["members"]:
                member_kinds[m["kind"]] += 1
                if m["kind"] == "accessor":
                    accessor_names[m["accessor"]] += 1
                if m["kind"] in ("method", "constructor"):
                    method_param_counts[min(len(m.get("params", [])), 10)] += 1

    # --- cycles ------------------------------------------------------------
    scc = [c for c in tarjan(list(local.keys()), internal_edges) if len(c) > 1]
    scc.sort(key=len, reverse=True)

    pkg_edges = defaultdict(set)
    pkg_of = {fq: class_rec[fq][0]["package"] for fq in class_rec}
    for fq, targets in internal_edges.items():
        src_pkg = pkg_of.get(fq, "")
        for t in targets:
            if t in pkg_of:
                pkg_edges[src_pkg].add(pkg_of[t])
    pkg_scc = [c for c in tarjan(sorted(packages), pkg_edges) if len(c) > 1]
    pkg_scc.sort(key=len, reverse=True)

    # --- entry points ------------------------------------------------------
    entry_candidates = []
    for fq, (rec, d) in class_rec.items():
        if d["kind"] == "class" and d.get("extends") in ("MovieClip", "Sprite"):
            entry_candidates.append({
                "fqcn": fq, "base": d["extends"], "package": rec["package"],
            })

    # base classes that are themselves declared locally (framework roots)
    framework_roots = sorted(
        {fq.split(".")[-1] for fq in local if not local[fq]["decl"].get("extends")}
    )

    summary = {
        "as3_files": len(records),
        "total_lines": sum(r["lines"] for r in records),
        "total_bytes": sum(r["bytes"] for r in records),
        "packages": len(packages),
        "classes": sum(1 for d in local.values() if d["decl"]["kind"] == "class"),
        "interfaces": sum(1 for d in local.values() if d["decl"]["kind"] == "interface"),
        "methods": member_kinds["method"],
        "constructors": member_kinds["constructor"],
        "getters": member_kinds["accessor"] and accessor_names["get"],
        "setters": accessor_names["set"],
        "fields": member_kinds["var"] + member_kinds["const"],
        "imports_total": sum(import_counts.values()),
        "imports_distinct": len(import_counts),
        "external_imports_distinct": len(external_imports),
        "unresolved_imports_distinct": len(unresolved),
        "duplicate_fqcns": len(duplicates),
        "local_inheritance_cycles": len(cycle_nodes),
        "scc_class_cycles": len(scc),
        "scc_package_cycles": len(pkg_scc),
        "embed_metadata": len(embeds),
        "constructor_param_max": max((len(m.get("params", [])) for d in local.values() for m in d["decl"]["members"] if m["kind"] == "constructor"), default=0),
    }

    report = {
        "tool": "corpus_scan.py",
        "root": str(root),
        "summary": summary,
        "language_features": feature.most_common(),
        "type_references": type_refs.most_common(120),
        "member_kinds": member_kinds.most_common(),
        "accessors": accessor_names.most_common(),
        "imports_top": import_counts.most_common(200),
        "flash_classes": flash_classes.most_common(200),
        "flash_reference_volume": flash_refs.most_common(200),
        "flash_inline_refs": inline_flash.most_common(100),
        "mx_imports": [(k, v) for k, v in import_counts.most_common() if k.startswith("mx.")],
        "external_imports": external_imports.most_common(150),
        "unresolved_imports": unresolved.most_common(150),
        "embedded_asset_extensions": extensions.most_common(),
        "embedded_mime_types": mimes.most_common(),
        "base_classes": base_counts.most_common(60),
        "unresolved_bases": unresolved_bases.most_common(80),
        "most_extended_local": [
            (base, len(kids), kids[:12]) for base, kids in
            sorted(local_children.items(), key=lambda kv: len(kv[1]), reverse=True)[:40]
        ],
        "duplicate_fqcns": duplicates,
        "class_cycles": scc[:25],
        "package_cycles": pkg_scc[:25],
        "entry_candidates": entry_candidates[:60],
        "packages": Counter(r["package"] or "(default)" for r in records).most_common(),
        "files": [
            {
                "file": r["file"], "package": r["package"], "lines": r["lines"],
                "imports": r["imports"],
                "declarations": [
                    {k: v for k, v in d.items() if k != "members"} for d in r["declarations"]
                ],
            }
            for r in records
        ],
    }
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(report, indent=2), encoding="utf-8")
    print(json.dumps({k: v for k, v in summary.items() if k != "files"}, indent=2))
    print(f"Wrote {args.out} ({args.out.stat().st_size / 1e6:.1f} MB)")


if __name__ == "__main__":
    main()
