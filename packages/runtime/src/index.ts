/** Minimal AS3 runtime ABI v1 kernel. Behavior grows with the backend. */

import {
  RUNTIME_EXTERNAL_CLASSES,
  RUNTIME_EXTERNAL_INTERFACES,
} from "../../shared/src/runtime-bindings.ts";
import { inflateRaw } from "../../shared/src/inflate.ts";
import { decodePng } from "./png.ts";
import { deflateRaw, zlibCompress, zlibDecompress } from "../../shared/src/deflate.ts";
import { parseSwf, type SwfImage, type SwfLibrary } from "./swf.ts";

export const ABI_VERSION = 1;

/** FQCNs that carry a runtime descriptor, for conformance tests and diagnostics. */
export function $runtimeClassNames(): string[] {
  return Object.keys(EXTERNAL_DEFINITIONS);
}

const registry = new Map<string, any>();

export class AS3RuntimeError extends Error {
  readonly api: string;

  constructor(api: string, message = `Unsupported AS3 runtime API: ${api}`) {
    super(message);
    this.name = "AS3RuntimeError";
    this.api = api;
  }
}

export function $interface(desc: any): any {
  const iface = {
    $isInterface: true,
    $desc: desc,
    $fqcn: desc.name,
    $extends: desc.extends ? desc.extends() : [],
  };
  registry.set(desc.name, iface);
  return iface;
}

export function $class(desc: any): any {
  if (desc.abi !== ABI_VERSION) {
    throw new Error(`AS3 ABI mismatch: expected ${ABI_VERSION}, got ${desc.abi}`);
  }

  const base = desc.base ? desc.base() : null;
  const interfaces = desc.interfaces ? desc.interfaces() : [];
  function ClassObject(this: any, ...args: any[]): any {
    return $construct(ClassObject, args);
  }

  if (base) Object.setPrototypeOf(ClassObject, base);
  ClassObject.prototype = Object.create(base ? base.prototype : Object.prototype);
  Object.defineProperty(ClassObject.prototype, "constructor", {
    value: ClassObject,
    writable: true,
    configurable: true,
  });
  Object.defineProperty(ClassObject, "$desc", { value: desc, writable: true });
  Object.defineProperty(ClassObject, "$fqcn", { value: desc.name, writable: true });
  Object.defineProperty(ClassObject, "$initialized", { value: false, writable: true });
  Object.defineProperty(ClassObject, "$interfaces", { value: interfaces, writable: true });

  for (const [name, method] of Object.entries(desc.methods ?? {})) {
    if (typeof (method as any)?.fn === "function") {
      ClassObject.prototype[name] = (method as any).fn;
    }
  }

  // A class that implements the flash_proxy protocol behaves like `flash.utils.Proxy`:
  // computed access goes through getProperty/setProperty and `for in` walks
  // nextNameIndex/nextName instead of the object's own JS properties.
  const methods = desc.methods as Record<string, { fn?: unknown }> | undefined;
  if (typeof methods?.getProperty?.fn === "function" && typeof methods?.nextNameIndex?.fn === "function") {
    Object.defineProperty(ClassObject.prototype, "__as3Proxy", {
      value: true,
      enumerable: false,
      configurable: true,
    });
  }

  for (const [name, accessor] of Object.entries(desc.accessors ?? {})) {
    const access = accessor as any;
    const hasGet = typeof access.get?.fn === "function";
    const hasSet = typeof access.set?.fn === "function";
    // AS3 lets a subclass override only one half of an inherited property. A JS accessor
    // descriptor with a missing half still shadows the inherited one, so carry the other half
    // over from the nearest base prototype that defines it.
    let inherited: PropertyDescriptor | undefined;
    if (base && (!hasGet || !hasSet)) {
      for (let proto = base.prototype; proto; proto = Object.getPrototypeOf(proto)) {
        const found = Object.getOwnPropertyDescriptor(proto, name);
        if (found && (found.get || found.set)) {
          inherited = found;
          break;
        }
      }
    }
    Object.defineProperty(ClassObject.prototype, name, {
      configurable: true,
      enumerable: false,
      get: hasGet ? access.get.fn : inherited?.get,
      set: hasSet ? access.set.fn : inherited?.set,
    });
  }

  for (const [name, method] of Object.entries(desc.statics ?? {})) {
    if (typeof method === "function") (ClassObject as any)[name] = method;
  }
  for (const [name, accessor] of Object.entries(desc.staticAccessors ?? {})) {
    const access = accessor as any;
    Object.defineProperty(ClassObject, name, {
      configurable: true,
      enumerable: false,
      get: typeof access.get?.fn === "function" ? access.get.fn : undefined,
      set: typeof access.set?.fn === "function" ? access.set.fn : undefined,
    });
  }

  for (const [name, field] of Object.entries(desc.staticValues ?? {})) {
    Object.defineProperty(ClassObject, name, {
      value: (field as any).value,
      writable: true,
      configurable: true,
      enumerable: true,
    });
  }

  registry.set(desc.name, ClassObject);
  return ClassObject;
}

export function $construct(C: any, args: any[]): any {
  const instance = Object.create(C.prototype);
  const ctor = C.$desc?.ctor?.fn;
  if (typeof ctor !== "function") throw new Error(`Class ${C.$fqcn} has no constructor`);
  const created = ctor.apply(instance, args);
  const target = created && typeof created === "object" ? created : instance;
  if (C.$desc?.metadata?.length) $applyEmbeddedAsset(target, C);
  return target;
}

export function $super(target: any, Base: any, args: any[]): void {
  const ctor = Base?.$desc?.ctor?.fn;
  if (typeof ctor !== "function") throw new Error("AS3 super constructor is missing");
  ctor.apply(target, args);
}

export function $superGet(target: any, Base: any, property: string): any {
  let proto = Base?.prototype;
  while (proto) {
    const descriptor = Object.getOwnPropertyDescriptor(proto, property);
    if (descriptor) {
      if (typeof descriptor.get === "function") return descriptor.get.call(target);
      // Reading through target[property] would re-enter a subclass accessor and recurse.
      return Object.prototype.hasOwnProperty.call(target, property) ? target[property] : descriptor.value;
    }
    proto = Object.getPrototypeOf(proto);
  }
  return target[property];
}

export function $superSet(target: any, Base: any, property: string, value: any): any {
  let proto = Base?.prototype;
  while (proto) {
    const descriptor = Object.getOwnPropertyDescriptor(proto, property);
    if (descriptor) {
      if (typeof descriptor.set === "function") descriptor.set.call(target, value);
      // A plain assignment would hit a subclass setter that called super, recursing forever.
      else Object.defineProperty(target, property, { value, writable: true, configurable: true, enumerable: true });
      return value;
    }
    proto = Object.getPrototypeOf(proto);
  }
  Object.defineProperty(target, property, { value, writable: true, configurable: true, enumerable: true });
  return value;
}

export function $superUpdate(
  target: any,
  Base: any,
  property: string,
  op: "++" | "--",
  prefix: boolean,
): any {
  const current = $superGet(target, Base, property);
  const next = op === "++" ? current + 1 : current - 1;
  $superSet(target, Base, property, next);
  return prefix ? next : current;
}

export function $superCall(target: any, Base: any, property: string, args: any[]): any {
  let proto = Base?.prototype;
  while (proto) {
    const descriptor = Object.getOwnPropertyDescriptor(proto, property);
    if (descriptor) {
      if (typeof descriptor.value === "function") return descriptor.value.apply(target, args);
      return target[property](...args);
    }
    proto = Object.getPrototypeOf(proto);
  }
  throw new Error(`AS3 super member '${property}' is missing`);
}

export function $ensureInit(C: any): void {
  if (C.$initialized) return;
  C.$initialized = true;
  const init = C.$desc?.staticInit;
  if (typeof init === "function") init.call(C);
}

export function $getClass(name: string): any {
  return registry.get(name) ?? null;
}

const hostSetTimeout = globalThis.setTimeout.bind(globalThis);
const hostClearTimeout = globalThis.clearTimeout.bind(globalThis);
const hostSetInterval = globalThis.setInterval.bind(globalThis);
const hostClearInterval = globalThis.clearInterval.bind(globalThis);
const runtimeStart = typeof performance !== "undefined" && typeof performance.now === "function"
  ? performance.now()
  : Date.now();

function runtimeNow(): number {
  return typeof performance !== "undefined" && typeof performance.now === "function"
    ? performance.now()
    : Date.now();
}

/** Milliseconds since the runtime module loaded, matching `getTimer`'s epoch behavior. */
export function getTimer(): number {
  return Math.floor(runtimeNow() - runtimeStart);
}

export function setTimeout(closure: any, delay = 0, ...args: any[]): any {
  if (typeof closure !== "function") throw new AS3RuntimeError("flash.utils.setTimeout", "Listener must be a function");
  return hostSetTimeout(() => closure(...args), delay);
}

export function clearTimeout(handle: any): void {
  hostClearTimeout(handle);
}

export function setInterval(closure: any, delay = 0, ...args: any[]): any {
  if (typeof closure !== "function") throw new AS3RuntimeError("flash.utils.setInterval", "Listener must be a function");
  return hostSetInterval(() => closure(...args), delay);
}

export function clearInterval(handle: any): void {
  hostClearInterval(handle);
}

export function getQualifiedClassName(value: any): string {
  if (value === null) return "null";
  if (value === undefined) return "void";
  switch (typeof value) {
    case "string":
      return "String";
    case "boolean":
      return "Boolean";
    case "number":
      return Number.isInteger(value) ? "int" : "Number";
    case "function":
      return value.$fqcn ?? value.$desc?.name ?? value.name ?? "Function";
    case "object": {
      if (Array.isArray(value)) return "Array";
      if (typeof value.$fqcn === "string" && value.$fqcn.length > 0) return value.$fqcn;
      const ctor = value.constructor;
      return ctor?.$fqcn ?? ctor?.$desc?.name ?? "Object";
    }
    default:
      return "Object";
  }
}

export function getQualifiedSuperclassName(value: any): string | null {
  const ctor = typeof value === "function" ? value : value?.constructor;
  const base = ctor?.$desc?.base?.();
  return base?.$fqcn ?? base?.$desc?.name ?? null;
}

export function getDefinitionByName(name: string): any {
  const known = $getClass(name) ?? runtimeClasses.get(name);
  if (known) return known;
  try {
    return $runtimeClass(name);
  } catch {
    throw new ReferenceError(`Definition ${name} was not found.`);
  }
}

/** Resolves an imported runtime function by FQCN; unsupported names fail loudly. */
export function $runtimeValue(name: string): any {
  switch (name) {
    case "flash.utils.getTimer":
      return getTimer;
    case "flash.utils.setTimeout":
      return setTimeout;
    case "flash.utils.clearTimeout":
      return clearTimeout;
    case "flash.utils.setInterval":
      return setInterval;
    case "flash.utils.clearInterval":
      return clearInterval;
    case "flash.utils.getQualifiedClassName":
      return getQualifiedClassName;
    case "flash.utils.getQualifiedSuperclassName":
      return getQualifiedSuperclassName;
    case "flash.utils.getDefinitionByName":
      return getDefinitionByName;
    case "flash.utils.describeType":
      return describeType;
    default:
      throw new AS3RuntimeError(name, `Runtime value '${name}' is not implemented`);
  }
}

type ExternalMethod = (this: any, ...args: any[]) => any;

interface ExternalDefinition {
  dynamic?: boolean;
  fields?: Record<string, { type: string }>;
  accessors?: Record<string, { get?: ExternalMethod; set?: ExternalMethod }>;
  methods?: Record<string, ExternalMethod>;
  statics?: Record<string, ExternalMethod>;
  staticValues?: Record<string, string | number | boolean | null>;
  staticAccessors?: Record<string, { get?: ExternalMethod; set?: ExternalMethod }>;
  init?: (target: any, args: any[]) => void;
  /** Replaces the constructed instance (used by proxy-backed classes such as Dictionary). */
  create?: (target: any, args: any[]) => any;
}

/** Constructs a runtime-provided class by FQCN, resolving it lazily. */
function runtimeNew(fqcn: string, ...args: any[]): any {
  const RuntimeClass = $runtimeClass(fqcn);
  return new RuntimeClass(...args);
}

/**
 * AS3 enumerates a plain object's own properties, and a dynamic class instance's fields.
 * A sealed class instance exposes nothing, which is why `for in` over a client object is
 * usually empty.
 */
function isEnumerableObject(value: any): boolean {
  if (value === null || typeof value !== "object") return false;
  const proto = Object.getPrototypeOf(value);
  if (proto === Object.prototype || proto === null) return true;
  return Boolean(value.constructor?.$desc?.flags?.dynamic);
}

function checkTimer(delay: number, repeatCount: number): void {
  if (!(delay >= 0) || !Number.isFinite(delay) || repeatCount < 0) {
    throw new RangeError("The Timer delay specified is out of range.");
  }
}

function clearTimer(timer: any): void {
  if (timer.__handle === null) return;
  hostClearInterval(timer.__handle);
  timer.__handle = null;
}

function scheduleTimer(timer: any): void {
  if (timer.__handle !== null) return;
  timer.__handle = hostSetInterval(() => tickTimer(timer), timer.__delay);
}

function tickTimer(timer: any): void {
  timer.__currentCount += 1;
  const complete = timer.__repeatCount > 0 && timer.__currentCount >= timer.__repeatCount;
  if (complete) clearTimer(timer);
  const TimerEvent = $runtimeClass("flash.events.TimerEvent");
  timer.dispatchEvent(new TimerEvent(TimerEvent.TIMER));
  if (complete) timer.dispatchEvent(new TimerEvent(TimerEvent.TIMER_COMPLETE));
}

interface ByteArrayState {
  bytes: Uint8Array;
  view: DataView;
  length: number;
  position: number;
  little: boolean;
  objectEncoding: number;
}

const byteArrayStates = new WeakMap<object, ByteArrayState>();
const utf8Encoder = new TextEncoder();
const utf8Decoder = new TextDecoder("utf-8");

function byteState(target: any, api: string): ByteArrayState {
  const state = byteArrayStates.get(target);
  if (!state) throw new AS3RuntimeError(api, "ByteArray state is missing");
  return state;
}

function byteReserve(state: ByteArrayState, size: number): void {
  if (size <= state.bytes.length) return;
  let capacity = Math.max(16, state.bytes.length);
  while (capacity < size) capacity *= 2;
  const next = new Uint8Array(capacity);
  next.set(state.bytes.subarray(0, state.length));
  state.bytes = next;
  state.view = new DataView(next.buffer);
}

function byteTake(state: ByteArrayState, count: number, api: string): void {
  if (count < 0 || count > state.length - state.position) {
    throw $error("EOFError", `End of file was encountered in ${api}.`);
  }
}

function bytePut(state: ByteArrayState, count: number): void {
  const end = state.position + count;
  byteReserve(state, end);
  if (state.position > state.length) state.bytes.fill(0, state.length, state.position);
  if (end > state.length) state.length = end;
}

function byteWriteRaw(state: ByteArrayState, data: Uint8Array): void {
  bytePut(state, data.length);
  state.bytes.set(data, state.position);
  state.position += data.length;
}

/** Maps an AS3 compression algorithm to the bundled codec; the rest stay honest errors. */
function compressionKind(algorithm: any, api: string): "zlib" | "deflate" {
  const name = String(algorithm ?? "zlib");
  if (name === "zlib" || name === "deflate") return name;
  throw new AS3RuntimeError(api, `Compression algorithm "${name}" is not implemented`);
}

/** Replaces a byte array's contents with `data`, as Flash's compress/deflate do. */
function byteReplace(state: ByteArrayState, data: Uint8Array): void {
  state.length = 0;
  state.position = 0;
  byteWriteRaw(state, data);
  state.position = 0;
}

/**
 * A byte array's element index for computed access (`bytes[index]`). Flash exposes the raw
 * bytes through integer property names as well as the read/write methods, and code that
 * decodes in place (Base64, packet splitting) relies on it. Non-integer keys are not byte
 * indices and fall back to ordinary property access.
 */
function byteArrayIndex(key: any): number | null {
  if (typeof key === "number") return Number.isInteger(key) && key >= 0 ? key : null;
  if (typeof key === "string" && /^\d+$/.test(key)) return Number(key);
  return null;
}

function byteArrayIndexGet(target: any, key: any): number | undefined {
  const state = byteArrayStates.get(target);
  if (!state) return undefined;
  const index = byteArrayIndex(key);
  if (index === null || index >= state.length) return undefined;
  return state.bytes[index];
}

/** Returns false when the key is not a byte index, so the caller can assign a property. */
function byteArrayIndexSet(target: any, key: any, value: any): boolean {
  const state = byteArrayStates.get(target);
  if (!state) return false;
  const index = byteArrayIndex(key);
  if (index === null) return false;
  if (index >= state.length) {
    // Flash extends the array and fills the gap with zeroes.
    byteReserve(state, index + 1);
    if (index > state.length) state.bytes.fill(0, state.length, index);
    state.length = index + 1;
  }
  state.bytes[index] = Number(value) & 0xff;
  return true;
}

function decodeUtf16(bytes: Uint8Array, littleEndian: boolean): string {
  let text = "";
  for (let index = 0; index + 1 < bytes.length; index += 2) {
    const first = bytes[index]!;
    const second = bytes[index + 1]!;
    text += String.fromCharCode(littleEndian ? first | (second << 8) : (first << 8) | second);
  }
  return text;
}

/** Charset encoding for `writeMultiByte`; unknown charsets fall back to UTF-8. */
function encodeCharset(value: string, charSet: string): Uint8Array {
  const name = charSet.toLowerCase().replace(/_/g, "-");
  if (name === "utf-16" || name === "utf-16le" || name === "unicode") {
    const out = new Uint8Array(value.length * 2);
    for (let index = 0; index < value.length; index += 1) {
      const code = value.charCodeAt(index);
      out[index * 2] = code & 0xff;
      out[index * 2 + 1] = code >> 8;
    }
    return out;
  }
  if (name === "utf-16be" || name === "unicodefffe") {
    const out = new Uint8Array(value.length * 2);
    for (let index = 0; index < value.length; index += 1) {
      const code = value.charCodeAt(index);
      out[index * 2] = code >> 8;
      out[index * 2 + 1] = code & 0xff;
    }
    return out;
  }
  const latin = ["iso-8859-1", "latin1", "l1", "iso8859-1", "us-ascii", "ascii", "windows-1252", "cp1252"];
  if (latin.includes(name)) {
    const max = name.includes("ascii") ? 0x7f : 0xff;
    const out = new Uint8Array(value.length);
    for (let index = 0; index < value.length; index += 1) {
      const code = value.charCodeAt(index);
      out[index] = code <= max ? code : 0x3f;
    }
    return out;
  }
  return utf8Encoder.encode(value);
}

const dictionaryMaps = new WeakMap<object, Map<any, any>>();

function dictionaryMap(target: any, api: string): Map<any, any> {
  const map = dictionaryMaps.get(target);
  if (!map) throw new AS3RuntimeError(api, "Dictionary state is missing");
  return map;
}

/**
 * Flash `Dictionary` key semantics: primitive keys are stored under their string
 * form, so `dict[10]` and `dict["10"]` reach the same entry. Objects and
 * functions are compared by identity instead.
 */
function dictionaryKey(key: any): any {
  return key !== null && (typeof key === "object" || typeof key === "function") ? key : String(key);
}

interface SocketState {
  webSocket: any;
  receive: any;
  send: any;
  connected: boolean;
  timeout: number;
}

const socketStates = new WeakMap<object, SocketState>();
let webSocketFactory: ((url: string) => any) | null = null;

/** Host hook for tests and alternative transports; pass null to restore the global WebSocket. */
export function $setWebSocketFactory(factory: ((url: string) => any) | null): void {
  webSocketFactory = factory;
}

function socketState(target: any, api: string): SocketState {
  const state = socketStates.get(target);
  if (!state) throw new AS3RuntimeError(api, "Socket state is missing");
  return state;
}

function socketUrl(host: string, port: number): string {
  if (/^wss?:\/\//i.test(host)) return host;
  // Flash hands the host to the OS resolver, which reads it as a C string: nothing after the
  // first NUL byte is part of the name. Clients that append padding bytes rely on that.
  const name = host.split("\u0000")[0] ?? host;
  return `${port === 443 ? "wss" : "ws"}://${name}:${port}`;
}

function createWebSocket(url: string): any {
  if (webSocketFactory) return webSocketFactory(url);
  const Ctor = (globalThis as any).WebSocket;
  if (typeof Ctor !== "function") {
    throw new AS3RuntimeError("Socket.connect", "No WebSocket implementation is available in this host");
  }
  return new Ctor(url);
}

/** Appends received bytes after any unread data, leaving the read position alone. */
function socketAppend(state: SocketState, chunk: Uint8Array): void {
  const target = byteState(state.receive, "Socket");
  const position = target.position;
  target.position = target.length;
  byteWriteRaw(target, chunk);
  target.position = position;
}

function socketInbound(target: any, state: SocketState, data: any): void {
  if (data instanceof ArrayBuffer) {
    socketAppend(state, new Uint8Array(data));
  } else if (ArrayBuffer.isView(data)) {
    socketAppend(state, new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
  } else if (typeof data === "string") {
    socketAppend(state, utf8Encoder.encode(data));
  } else if (data && typeof data.arrayBuffer === "function") {
    void data.arrayBuffer().then((buffer: ArrayBuffer) => {
      socketAppend(state, new Uint8Array(buffer));
      dispatchSocketData(target);
    });
    return;
  }
  dispatchSocketData(target);
}

function dispatchSocketData(target: any): void {
  const ProgressEvent = $runtimeClass("flash.events.ProgressEvent");
  target.dispatchEvent(new ProgressEvent(ProgressEvent.SOCKET_DATA));
}

function socketSnapshot(target: any): Uint8Array {
  const state = byteState(target, "Socket");
  return state.bytes.slice(0, state.length);
}

function socketReadMethods(api: string): Record<string, (this: any, ...args: any[]) => any> {
  const names = [
    "readBoolean", "readByte", "readUnsignedByte", "readShort", "readUnsignedShort",
    "readInt", "readUnsignedInt", "readFloat", "readDouble", "readUTF", "readUTFBytes",
    "readBytes", "readMultiByte",
  ];
  return Object.fromEntries(
    names.map((name) => [
      name,
      function(this: any, ...args: any[]) {
        return socketState(this, `${api}.${name}`).receive[name](...args);
      },
    ]),
  );
}

function socketWriteMethods(api: string): Record<string, (this: any, ...args: any[]) => void> {
  const names = [
    "writeBoolean", "writeByte", "writeUnsignedByte", "writeShort", "writeInt",
    "writeUnsignedInt", "writeFloat", "writeDouble", "writeUTF", "writeUTFBytes",
    "writeBytes", "writeMultiByte",
  ];
  return Object.fromEntries(
    names.map((name) => [
      name,
      function(this: any, ...args: any[]) {
        socketState(this, `${api}.${name}`).send[name](...args);
      },
    ]),
  );
}

/* ------------------------------------------------------------------ *
 * XML / E4X subset
 * ------------------------------------------------------------------ */

interface XmlNode {
  kind: "element" | "text" | "attribute" | "comment";
  name: string;
  value: string;
  attributes: Map<string, string>;
  children: XmlNode[];
}

function xmlElement(name: string): XmlNode {
  return { kind: "element", name, value: "", attributes: new Map(), children: [] };
}

function xmlText(value: string): XmlNode {
  return { kind: "text", name: "", value, attributes: new Map(), children: [] };
}

/** Deep copy used by `XML.copy()`; attributes and children are independent afterwards. */
function cloneXmlNode(node: XmlNode): XmlNode {
  return {
    kind: node.kind,
    name: node.name,
    value: node.value,
    attributes: new Map(node.attributes),
    children: node.children.map(cloneXmlNode),
  };
}

function decodeXmlEntities(value: string): string {
  return value.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (match, body: string) => {
    if (body.startsWith("#x") || body.startsWith("#X")) {
      const code = Number.parseInt(body.slice(2), 16);
      return Number.isFinite(code) ? String.fromCodePoint(code) : match;
    }
    if (body.startsWith("#")) {
      const code = Number.parseInt(body.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : match;
    }
    switch (body) {
      case "amp":
        return "&";
      case "lt":
        return "<";
      case "gt":
        return ">";
      case "quot":
        return '"';
      case "apos":
        return "'";
      default:
        return match;
    }
  });
}

/** Parses the documented E4X XML subset: elements, attributes, text, CDATA and comments. */
function parseXmlSource(source: string): XmlNode {
  const text = String(source ?? "");
  let index = 0;
  const fail = (message: string): never => {
    throw new TypeError(`Invalid XML: ${message} (offset ${index})`);
  };
  const skipWhitespace = (): void => {
    while (index < text.length && /\s/.test(text[index]!)) index += 1;
  };
  const readName = (): string => {
    const start = index;
    while (index < text.length && /[^\s/>=]/.test(text[index]!)) index += 1;
    if (start === index) fail("expected a name");
    return text.slice(start, index);
  };
  const readUntil = (marker: string): string => {
    const end = text.indexOf(marker, index);
    if (end < 0) fail(`missing '${marker}'`);
    const value = text.slice(index, end);
    index = end + marker.length;
    return value;
  };
  const parseElement = (): XmlNode => {
    index += 1;
    if (text[index] === "/") fail("unexpected closing tag");
    const node = xmlElement(readName());
    for (;;) {
      skipWhitespace();
      if (index >= text.length) fail("unexpected end of input");
      if (text[index] === "/" && text[index + 1] === ">") {
        index += 2;
        return node;
      }
      if (text[index] === ">") {
        index += 1;
        break;
      }
      const name = readName();
      skipWhitespace();
      if (text[index] !== "=") fail("expected '=' after attribute name");
      index += 1;
      skipWhitespace();
      const quote = text[index];
      if (quote !== '"' && quote !== "'") fail("expected a quoted attribute value");
      index += 1;
      const end = text.indexOf(quote!, index);
      if (end < 0) fail("unterminated attribute value");
      node.attributes.set(name, decodeXmlEntities(text.slice(index, end)));
      index = end + 1;
    }
    for (;;) {
      if (index >= text.length) fail(`unclosed element <${node.name}>`);
      if (text.startsWith("</", index)) {
        index += 2;
        const name = readName();
        skipWhitespace();
        if (text[index] !== ">") fail("expected '>'");
        index += 1;
        if (name !== node.name) fail(`mismatched closing tag </${name}> for <${node.name}>`);
        return node;
      }
      if (text.startsWith("<!--", index)) {
        index += 4;
        readUntil("-->");
        continue;
      }
      if (text.startsWith("<![CDATA[", index)) {
        index += 9;
        node.children.push(xmlText(readUntil("]]>")));
        continue;
      }
      if (text.startsWith("<?", index)) {
        index += 2;
        readUntil("?>");
        continue;
      }
      if (text[index] === "<") {
        node.children.push(parseElement());
        continue;
      }
      const start = index;
      while (index < text.length && text[index] !== "<") index += 1;
      const value = decodeXmlEntities(text.slice(start, index));
      if (value.trim().length > 0) node.children.push(xmlText(value));
    }
  };

  const nodes: XmlNode[] = [];
  while (index < text.length) {
    skipWhitespace();
    if (index >= text.length) break;
    if (text.startsWith("<?", index)) {
      index += 2;
      readUntil("?>");
      continue;
    }
    if (text.startsWith("<!--", index)) {
      index += 4;
      readUntil("-->");
      continue;
    }
    if (text.startsWith("<!DOCTYPE", index) || text.startsWith("<!doctype", index)) {
      readUntil(">");
      continue;
    }
    if (text[index] === "<") {
      nodes.push(parseElement());
      continue;
    }
    const start = index;
    while (index < text.length && text[index] !== "<") index += 1;
    const value = decodeXmlEntities(text.slice(start, index));
    if (value.trim().length > 0) nodes.push(xmlText(value));
  }
  if (nodes.length === 0) return xmlText("");
  if (nodes.length > 1) fail("multiple root elements");
  return nodes[0]!;
}

function escapeXmlText(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function escapeXmlAttribute(value: string): string {
  return escapeXmlText(value).replace(/"/g, "&quot;");
}

function serializeXmlNode(node: XmlNode): string {
  switch (node.kind) {
    case "text":
      return escapeXmlText(node.value);
    case "comment":
      return `<!--${node.value}-->`;
    case "attribute":
      return node.value;
    case "element": {
      const attributes = [...node.attributes]
        .map(([name, value]) => ` ${name}="${escapeXmlAttribute(value)}"`)
        .join("");
      if (node.children.length === 0) return `<${node.name}${attributes}/>`;
      return `<${node.name}${attributes}>${node.children.map(serializeXmlNode).join("")}</${node.name}>`;
    }
  }
}

const xmlNodes = new WeakMap<object, XmlNode>();
const xmlLists = new WeakMap<object, XmlNode[]>();

function isXmlNode(value: any): value is XmlNode {
  return Boolean(value) && typeof value === "object" &&
    typeof value.kind === "string" && value.attributes instanceof Map && Array.isArray(value.children);
}

function isXmlObject(value: any): boolean {
  return value !== null && typeof value === "object" && xmlNodes.has(value);
}

function isXmlListObject(value: any): boolean {
  return value !== null && typeof value === "object" && xmlLists.has(value);
}

function xmlNodeState(target: any, api: string): XmlNode {
  const state = xmlNodes.get(target);
  if (!state) throw new AS3RuntimeError(api, "XML state is missing");
  return state;
}

function xmlListState(target: any, api: string): XmlNode[] {
  const state = xmlLists.get(target);
  if (!state) throw new AS3RuntimeError(api, "XMLList state is missing");
  return state;
}

function wrapXmlNode(node: XmlNode): any {
  return runtimeNew("XML", node);
}

function wrapXmlList(nodes: XmlNode[]): any {
  return runtimeNew("XMLList", nodes);
}

function xmlValueNodes(value: any, api: string): XmlNode[] {
  if (isXmlObject(value)) return [xmlNodeState(value, api)];
  if (isXmlListObject(value)) return xmlListState(value, api);
  throw new AS3RuntimeError(api, "Value is not an XML or XMLList object");
}

function xmlElementChildren(node: XmlNode, name: string): XmlNode[] {
  const out: XmlNode[] = [];
  if (node.kind !== "element") return out;
  for (const child of node.children) {
    if (child.kind === "element" && (name === "*" || child.name === name)) out.push(child);
  }
  return out;
}

/** E4X `child(n)`: a numeric argument selects the n-th element child. */
function xmlIndexedChild(node: XmlNode, index: number): XmlNode[] {
  const elements = xmlElementChildren(node, "*");
  const selected = index >= 0 ? elements[Math.trunc(index)] : undefined;
  return selected ? [selected] : [];
}

function xmlChildrenOf(nodes: readonly XmlNode[], name: string): XmlNode[] {
  const out: XmlNode[] = [];
  for (const node of nodes) out.push(...xmlElementChildren(node, name));
  return out;
}

function xmlDescendantsOf(nodes: readonly XmlNode[], name: string): XmlNode[] {
  const out: XmlNode[] = [];
  const visit = (node: XmlNode): void => {
    if (node.kind !== "element") return;
    for (const child of node.children) {
      if (child.kind !== "element") continue;
      if (name === "*" || child.name === name) out.push(child);
      visit(child);
    }
  };
  for (const node of nodes) visit(node);
  return out;
}

function xmlAttributeNodes(node: XmlNode, name: string): XmlNode[] {
  if (node.kind !== "element") return [];
  if (name === "*") {
    return [...node.attributes].map(([key, value]) => ({
      kind: "attribute" as const,
      name: key,
      value,
      attributes: new Map<string, string>(),
      children: [],
    }));
  }
  return node.attributes.has(name)
    ? [{
      kind: "attribute" as const,
      name,
      value: node.attributes.get(name)!,
      attributes: new Map<string, string>(),
      children: [],
    }]
    : [];
}

function xmlDirectText(nodes: readonly XmlNode[]): string {
  let text = "";
  for (const node of nodes) {
    if (node.kind === "text") text += node.value;
    else if (node.kind === "element") {
      for (const child of node.children) if (child.kind === "text") text += child.value;
    }
  }
  return text;
}

function xmlStringValue(nodes: readonly XmlNode[]): string {
  return nodes.map((node) => (node.kind === "attribute" || node.kind === "text"
    ? node.value
    : serializeXmlNode(node))).join("");
}

/**
 * E4X `toString`: simple content prints as text, complex content as markup. A node-set with any
 * element child is complex, so it serializes; anything else contributes its text, which turns
 * `<name>Star rug</name>` into "Star rug" and an empty `<description/>` into "".
 */
function xmlSimpleContentString(nodes: readonly XmlNode[]): string {
  let text = "";
  for (const node of nodes) {
    if (node.kind !== "element") {
      text += node.value;
      continue;
    }
    if (node.children.some((child) => child.kind === "element")) return xmlStringValue(nodes);
    text += xmlDirectText([node]);
  }
  return text;
}

/**
 * Flash converts an XML node-set to a number through its text value, not its markup:
 * `uint(<w style="101"/> .@style)` is 101 and `Number(<n>7</n>)` is 7. Attribute and text
 * values come through directly; an element contributes its direct text children, as E4X
 * `valueOf` does.
 */
function xmlNumericString(nodes: readonly XmlNode[]): string {
  let text = "";
  for (const node of nodes) {
    if (node.kind === "attribute" || node.kind === "text") {
      text += node.value;
    } else {
      for (const child of node.children) if (child.kind === "text") text += child.value;
    }
  }
  return text;
}

function appendXmlChild(target: XmlNode, child: any, api: string): void {
  if (target.kind !== "element") throw new AS3RuntimeError(api, "appendChild requires an element node");
  const nodes = isXmlObject(child)
    ? [xmlNodeState(child, api)]
    : isXmlListObject(child)
      ? xmlListState(child, api)
      : [xmlText(child === null || child === undefined ? "" : String(child))];
  for (const node of nodes) {
    if (node.kind === "attribute") throw new AS3RuntimeError(api, "Cannot append an attribute node");
    target.children.push(node);
  }
}

function xmlProxyHandler(): ProxyHandler<any> {
  return {
    get(object, property, receiver) {
      const state = xmlNodes.get(receiver);
      if (property === Symbol.toPrimitive) {
        return (hint: string) => hint === "number"
          ? Number(state ? xmlNumericString([state]) : "")
          : (state ? xmlSimpleContentString([state]) : "");
      }
      if (property === "valueOf") return () => (state ? xmlNumericString([state]) : "");
      if (typeof property === "symbol") return Reflect.get(object, property, receiver);
      if (!state) return Reflect.get(object, property, receiver);
      if (/^(0|[1-9]\d*)$/.test(property)) return property === "0" ? receiver : undefined;
      // A child element shadows a same-named member, as in Flash: furni data reads `k.name`
      // for its <name> child even though XML also has a `name()` method.
      if (state.kind === "element") {
        const children = xmlElementChildren(state, property);
        if (children.length > 0) return wrapXmlList(children);
      }
      const own = Reflect.get(object, property, receiver);
      if (own !== undefined) return own;
      return state.kind === "element" ? wrapXmlList([]) : undefined;
    },
    set(object, property, value, receiver) {
      if (typeof property === "symbol") return Reflect.set(object, property, value, receiver);
      const state = xmlNodes.get(receiver);
      if (state?.kind === "element" && !Reflect.has(object, property)) {
        state.attributes.set(property, String(value));
        return true;
      }
      return Reflect.set(object, property, value, receiver);
    },
    has(object, property) {
      if (typeof property === "symbol") return Reflect.has(object, property);
      const state = xmlNodes.get(object);
      return Boolean(state?.kind === "element" && state.attributes.has(property)) || Reflect.has(object, property);
    },
    ownKeys(object) {
      const state = xmlNodes.get(object);
      return state?.kind === "element" ? [...state.attributes.keys()] : Reflect.ownKeys(object);
    },
    getOwnPropertyDescriptor(object, property) {
      const state = xmlNodes.get(object);
      if (state?.kind === "element" && typeof property === "string" && state.attributes.has(property)) {
        return {
          value: state.attributes.get(property),
          enumerable: true,
          configurable: true,
          writable: true,
        };
      }
      return Reflect.getOwnPropertyDescriptor(object, property);
    },
  };
}

function xmlListProxyHandler(): ProxyHandler<any> {
  return {
    get(object, property, receiver) {
      const nodes = xmlLists.get(receiver);
      if (property === Symbol.toPrimitive) {
        return (hint: string) => hint === "number"
          ? Number(nodes ? xmlNumericString(nodes) : "")
          : (nodes ? xmlSimpleContentString(nodes) : "");
      }
      if (property === "valueOf") return () => (nodes ? xmlNumericString(nodes) : "");
      if (typeof property === "symbol") return Reflect.get(object, property, receiver);
      if (!nodes) return Reflect.get(object, property, receiver);
      if (/^(0|[1-9]\d*)$/.test(property)) {
        const node = nodes[Number(property)];
        return node ? wrapXmlNode(node) : undefined;
      }
      const children = xmlChildrenOf(nodes, property);
      if (children.length > 0) return wrapXmlList(children);
      const own = Reflect.get(object, property, receiver);
      if (own !== undefined) return own;
      return wrapXmlList([]);
    },
  };
}

/** `xml.@name` / `xmlList.@name`: always an XMLList node-set of attribute nodes. */
export function $xmlAttribute(value: any, name: string): any {
  const nodes = xmlValueNodes(value, "XML.@attribute");
  return wrapXmlList(nodes.flatMap((node) => xmlAttributeNodes(node, String(name))));
}

/** `xml.@name = value` / `xml.@["name"] = value`: writes each element in the node-set. */
export function $xmlSetAttribute(value: any, name: string, attributeValue: any): any {
  const nodes = xmlValueNodes(value, "XML.@attribute write");
  for (const node of nodes) {
    if (node.kind === "element") node.attributes.set(String(name), String(attributeValue));
  }
  return attributeValue;
}

/** `xml..name` / `xml..*`: descendant elements in document order. */
export function $xmlDescendants(value: any, name: string): any {
  const nodes = xmlValueNodes(value, "XML..descendants");
  return wrapXmlList(xmlDescendantsOf(nodes, String(name)));
}

/** E4X filter predicate: invoke the predicate with the current node as `this`. */
export function $xmlFilter(value: any, predicate: (this: any) => unknown): any {
  const nodes = xmlValueNodes(value, "XML.filter");
  return wrapXmlList(nodes.filter((node) => Boolean(predicate.call(wrapXmlNode(node)))));
}

/** Lowers an XML literal by constructing an XML instance from its source text. */
export function $xmlLiteral(source: string): any {
  return runtimeNew("XML", source);
}

/* ------------------------------------------------------------------ *
 * Reflection: describeType
 * ------------------------------------------------------------------ */

function describeTypeSource(value: any): string {
  const direct = value?.$desc;
  const ctor = typeof value === "function" ? value : value?.constructor;
  const desc = direct ?? ctor?.$desc ?? null;
  if (!desc) {
    const name = getQualifiedClassName(value);
    return `<type name="${escapeXmlAttribute(name)}" base="Object" isDynamic="false" isFinal="true" isStatic="false"/>`;
  }
  const isClass = typeof value === "function";
  const fqcn = value.$fqcn ?? ctor?.$fqcn ?? desc.name ?? "Object";
  const base = desc.base ? desc.base() : null;
  const declared = desc.interfaces ? desc.interfaces() : [];
  // Flash lists inherited interfaces as well; ClassUtils.implementsInterface depends on it.
  const interfaces: any[] = [];
  const seenInterfaces = new Set<string>();
  const addInterfaces = (list: readonly any[]): void => {
    for (const implemented of list) {
      const name = implemented?.$fqcn ?? implemented?.$desc?.name ?? "";
      if (!name || seenInterfaces.has(name)) continue;
      seenInterfaces.add(name);
      interfaces.push(implemented);
    }
  };
  addInterfaces(declared);
  for (let ancestor = base; ancestor; ancestor = ancestor.$desc?.base?.() ?? null) {
    addInterfaces(ancestor.$interfaces ?? []);
  }
  const flags = desc.flags ?? {};
  // A class description nests members in <factory>; an instance description does not.
  const pad = isClass ? "    " : "  ";
  const lines: string[] = [];
  lines.push(
    `<type name="${escapeXmlAttribute(fqcn)}"${base ? ` base="${escapeXmlAttribute(base.$fqcn ?? base.$desc?.name ?? "Object")}"` : ""}` +
      ` isDynamic="${Boolean(flags.dynamic)}" isFinal="${Boolean(flags.final)}" isStatic="false">`,
  );
  if (isClass) lines.push(`  <factory type="${escapeXmlAttribute(fqcn)}">`);
  if (base) lines.push(`${pad}<extendsClass type="${escapeXmlAttribute(base.$fqcn ?? base.$desc?.name ?? "Object")}"/>`);
  for (const implemented of interfaces) {
    lines.push(`${pad}<implementsInterface type="${escapeXmlAttribute(implemented.$fqcn ?? implemented.$desc?.name ?? "")}"/>`);
  }
  for (const [name, field] of Object.entries(desc.fields ?? {})) {
    const type = (field as any)?.type ?? "*";
    lines.push(`${pad}<variable name="${name}" type="${escapeXmlAttribute(type)}" declaredBy="${escapeXmlAttribute(fqcn)}"/>`);
  }
  for (const [name, accessor] of Object.entries(desc.accessors ?? {})) {
    const access = accessor as any;
    const mode = access.get && access.set ? "readwrite" : access.get ? "readonly" : "writeonly";
    const type = access.get?.type ?? access.set?.type ?? "*";
    lines.push(
      `${pad}<accessor name="${name}" access="${mode}" type="${escapeXmlAttribute(type)}" declaredBy="${escapeXmlAttribute(fqcn)}"/>`,
    );
  }
  for (const [name, method] of Object.entries(desc.methods ?? {})) {
    const type = (method as any)?.returns ?? "*";
    lines.push(`${pad}<method name="${name}" declaredBy="${escapeXmlAttribute(fqcn)}" returnType="${escapeXmlAttribute(type)}"/>`);
  }
  for (const [name, value] of Object.entries(desc.staticValues ?? {})) {
    const type = (value as any)?.type ?? "*";
    lines.push(`${pad}<constant name="${name}" type="${escapeXmlAttribute(type)}" declaredBy="${escapeXmlAttribute(fqcn)}"/>`);
  }
  for (const name of Object.keys(desc.statics ?? {})) {
    lines.push(`${pad}<method name="${name}" declaredBy="${escapeXmlAttribute(fqcn)}" returnType="*" static="true"/>`);
  }
  if (isClass) lines.push("  </factory>");
  lines.push("</type>");
  return lines.join("\n");
}

/** Flash's `describeType` subset: class, base, interfaces, members and constants. */
export function describeType(value: any): any {
  return runtimeNew("XML", describeTypeSource(value));
}

/* ------------------------------------------------------------------ *
 * URL loading
 * ------------------------------------------------------------------ */

interface UrlLoaderState {
  controller: any | null;
}

interface UrlStreamState {
  controller: any | null;
  receive: any;
  connected: boolean;
}

const urlLoaderStates = new WeakMap<object, UrlLoaderState>();
const urlStreamStates = new WeakMap<object, UrlStreamState>();
const soundStates = new WeakMap<object, { controller: AbortController | null }>();

function soundState(target: any, api: string): { controller: AbortController | null } {
  const state = soundStates.get(target);
  if (!state) throw new AS3RuntimeError(api, "Sound state is missing");
  return state;
}

function urlLoaderState(target: any, api: string): UrlLoaderState {
  const state = urlLoaderStates.get(target);
  if (!state) throw new AS3RuntimeError(api, "URLLoader state is missing");
  return state;
}

function urlStreamState(target: any, api: string): UrlStreamState {
  const state = urlStreamStates.get(target);
  if (!state) throw new AS3RuntimeError(api, "URLStream state is missing");
  return state;
}

function requestHeaders(request: any): Headers {
  const headers = new Headers();
  for (const header of request?.requestHeaders ?? []) {
    if (header && header.name !== undefined) headers.set(String(header.name), String(header.value ?? ""));
  }
  if (request?.contentType) headers.set("Content-Type", String(request.contentType));
  return headers;
}

function requestBody(request: any, method: string): any {
  if (method === "GET" || method === "HEAD") return undefined;
  const data = request?.data;
  if (data === null || data === undefined) return undefined;
  if (typeof data === "string") return data;
  if (typeof data.toString === "function") return data.toString();
  return String(data);
}

function requestUrl(request: any): string {
  const url = String(request?.url ?? "");
  if (url.length === 0) throw new Error("URLRequest.url is empty");
  return runtimeResolveUrl(url);
}

function streamReadMethods(api: string): Record<string, (this: any, ...args: any[]) => any> {
  const names = [
    "readBoolean", "readByte", "readUnsignedByte", "readShort", "readUnsignedShort",
    "readInt", "readUnsignedInt", "readFloat", "readDouble", "readUTF", "readUTFBytes",
    "readBytes", "readMultiByte",
  ];
  return Object.fromEntries(
    names.map((name) => [
      name,
      function(this: any, ...args: any[]) {
        return urlStreamState(this, `${api}.${name}`).receive[name](...args);
      },
    ]),
  );
}

/* ------------------------------------------------------------------ *
 * Display list drawing and bitmap pixels
 * ------------------------------------------------------------------ */

interface GraphicsSolidFill {
  kind: "solid";
  color: number;
  alpha: number;
}

/** A fill matrix snapshot; Flash copies the matrix when begin*Fill runs. */
interface GraphicsFillMatrix {
  a: number;
  b: number;
  c: number;
  d: number;
  tx: number;
  ty: number;
}

interface GraphicsGradientFill {
  kind: "gradient";
  type: string;
  colors: number[];
  alphas: number[];
  ratios: number[];
  matrix: GraphicsFillMatrix | null;
  focal: number;
}

interface GraphicsBitmapFill {
  kind: "bitmap";
  bitmap: any;
  matrix: GraphicsFillMatrix | null;
  repeat: boolean;
  smooth: boolean;
}

type GraphicsFill = GraphicsSolidFill | GraphicsGradientFill | GraphicsBitmapFill;

interface GraphicsStroke {
  thickness: number;
  color: number;
  alpha: number;
}

type GraphicsSegment =
  | { kind: "line"; x: number; y: number }
  | { kind: "curve"; cx: number; cy: number; x: number; y: number };

type GraphicsCommand =
  | { kind: "rect"; x: number; y: number; width: number; height: number; fill: GraphicsFill | null; stroke: GraphicsStroke | null }
  | {
    kind: "roundRect";
    x: number; y: number; width: number; height: number;
    ellipseWidth: number; ellipseHeight: number;
    fill: GraphicsFill | null; stroke: GraphicsStroke | null;
  }
  | { kind: "ellipse"; x: number; y: number; width: number; height: number; fill: GraphicsFill | null; stroke: GraphicsStroke | null }
  | { kind: "circle"; x: number; y: number; radius: number; fill: GraphicsFill | null; stroke: GraphicsStroke | null }
  | {
    kind: "path";
    startX: number; startY: number; segments: GraphicsSegment[];
    fill: GraphicsFill | null; stroke: GraphicsStroke | null;
  };

interface GraphicsState {
  commands: GraphicsCommand[];
  fill: GraphicsFill | null;
  stroke: GraphicsStroke | null;
  startX: number;
  startY: number;
  segments: GraphicsSegment[];
}

interface BitmapDataState {
  width: number;
  height: number;
  transparent: boolean;
  pixels: Uint32Array;
  /** Moves on every write so the blit surface can be reused between frames. */
  version: number;
  surface?: BitmapSurface;
}

/** A canvas holding one bitmap's pixels, rebuilt only when its version moves. */
interface BitmapSurface {
  canvas: any;
  context: any;
  version: number;
  width: number;
  height: number;
}

const graphicsStates = new WeakMap<object, GraphicsState>();
const bitmapDataStates = new WeakMap<object, BitmapDataState>();

function graphicsState(target: any, api: string): GraphicsState {
  const state = graphicsStates.get(target);
  if (!state) throw new AS3RuntimeError(api, "Graphics state is missing");
  return state;
}

function bitmapDataState(target: any, api: string): BitmapDataState {
  const state = bitmapDataStates.get(target);
  if (!state) throw new AS3RuntimeError(api, "BitmapData state is missing");
  return state;
}

function finishGraphicsPath(state: GraphicsState): void {
  if (state.segments.length === 0) return;
  state.commands.push({
    kind: "path",
    startX: state.startX,
    startY: state.startY,
    segments: state.segments,
    fill: state.fill,
    stroke: state.stroke,
  });
  state.segments = [];
}

function cssColor(value: number): string {
  return `#${(value & 0xffffff).toString(16).padStart(6, "0")}`;
}

interface ComposedColor {
  redMultiplier: number;
  greenMultiplier: number;
  blueMultiplier: number;
  alphaMultiplier: number;
  redOffset: number;
  greenOffset: number;
  blueOffset: number;
  alphaOffset: number;
}

const IDENTITY_COLOR: ComposedColor = {
  redMultiplier: 1,
  greenMultiplier: 1,
  blueMultiplier: 1,
  alphaMultiplier: 1,
  redOffset: 0,
  greenOffset: 0,
  blueOffset: 0,
  alphaOffset: 0,
};

function colorOf(value: any): ComposedColor {
  return {
    redMultiplier: Number(value?.redMultiplier ?? 1),
    greenMultiplier: Number(value?.greenMultiplier ?? 1),
    blueMultiplier: Number(value?.blueMultiplier ?? 1),
    alphaMultiplier: Number(value?.alphaMultiplier ?? 1),
    redOffset: Number(value?.redOffset ?? 0),
    greenOffset: Number(value?.greenOffset ?? 0),
    blueOffset: Number(value?.blueOffset ?? 0),
    alphaOffset: Number(value?.alphaOffset ?? 0),
  };
}

/** Flash's ColorTransform.concat: offsets scale by the parent's multipliers. */
function concatColor(parent: ComposedColor, child: ComposedColor): ComposedColor {
  return {
    redMultiplier: parent.redMultiplier * child.redMultiplier,
    greenMultiplier: parent.greenMultiplier * child.greenMultiplier,
    blueMultiplier: parent.blueMultiplier * child.blueMultiplier,
    alphaMultiplier: parent.alphaMultiplier * child.alphaMultiplier,
    redOffset: parent.redOffset + parent.redMultiplier * child.redOffset,
    greenOffset: parent.greenOffset + parent.greenMultiplier * child.greenOffset,
    blueOffset: parent.blueOffset + parent.blueMultiplier * child.blueOffset,
    alphaOffset: parent.alphaOffset + parent.alphaMultiplier * child.alphaOffset,
  };
}

function isIdentityColor(color: ComposedColor): boolean {
  return (
    color.redMultiplier === 1 && color.greenMultiplier === 1 && color.blueMultiplier === 1 &&
    color.alphaMultiplier === 1 && color.redOffset === 0 && color.greenOffset === 0 &&
    color.blueOffset === 0 && color.alphaOffset === 0
  );
}

function tintChannel(value: number, multiplier: number, offset: number): number {
  return Math.min(255, Math.max(0, Math.round(value * multiplier + offset)));
}

function tintedColorNumber(color: number, transform: ComposedColor): number {
  return (
    (tintChannel((color >>> 16) & 0xff, transform.redMultiplier, transform.redOffset) << 16) |
    (tintChannel((color >>> 8) & 0xff, transform.greenMultiplier, transform.greenOffset) << 8) |
    tintChannel(color & 0xff, transform.blueMultiplier, transform.blueOffset)
  ) >>> 0;
}

function rgbaColor(color: number, alpha: number): string {
  return `rgba(${(color >>> 16) & 0xff},${(color >>> 8) & 0xff},${color & 0xff},${Math.max(0, Math.min(1, alpha))})`;
}

/** Flash blend modes mapped to the canvas operations that match them. */
const CANVAS_COMPOSITE: Record<string, string> = {
  add: "lighter",
  multiply: "multiply",
  screen: "screen",
  overlay: "overlay",
  darken: "darken",
  lighten: "lighten",
  difference: "difference",
  hardlight: "hard-light",
  "hard light": "hard-light",
  "color-dodge": "color-dodge",
  "color-burn": "color-burn",
  hue: "hue",
  saturation: "saturation",
  color: "color",
  luminosity: "luminosity",
};

function canvasCompositeOperation(blendMode: string): string {
  return CANVAS_COMPOSITE[blendMode] ?? "source-over";
}

/** Flash's gradient box: the gradient runs across x from -819.2 to 819.2 before its matrix. */
const GRADIENT_HALF_BOX = 819.2;

function graphicsFillMatrix(matrix: any): GraphicsFillMatrix {
  return {
    a: Number(matrix?.a ?? 1),
    b: Number(matrix?.b ?? 0),
    c: Number(matrix?.c ?? 0),
    d: Number(matrix?.d ?? 1),
    tx: Number(matrix?.tx ?? 0),
    ty: Number(matrix?.ty ?? 0),
  };
}

function graphicsFillMatrixSnapshot(matrix: any): GraphicsFillMatrix | null {
  return matrix == null ? null : graphicsFillMatrix(matrix);
}

function colorSignature(color: ComposedColor): string {
  return [
    color.redMultiplier, color.greenMultiplier, color.blueMultiplier, color.alphaMultiplier,
    color.redOffset, color.greenOffset, color.blueOffset, color.alphaOffset,
  ].join(",");
}

function bitmapRgba(state: BitmapDataState, color: ComposedColor): Uint8ClampedArray {
  const identity = isIdentityColor(color);
  const rgba = new Uint8ClampedArray(state.width * state.height * 4);
  for (let index = 0; index < state.pixels.length; index += 1) {
    const argb = state.pixels[index]!;
    rgba[index * 4] = identity
      ? (argb >>> 16) & 0xff
      : tintChannel((argb >>> 16) & 0xff, color.redMultiplier, color.redOffset);
    rgba[index * 4 + 1] = identity
      ? (argb >>> 8) & 0xff
      : tintChannel((argb >>> 8) & 0xff, color.greenMultiplier, color.greenOffset);
    rgba[index * 4 + 2] = identity
      ? argb & 0xff
      : tintChannel(argb & 0xff, color.blueMultiplier, color.blueOffset);
    rgba[index * 4 + 3] = identity
      ? (argb >>> 24) & 0xff
      : tintChannel((argb >>> 24) & 0xff, color.alphaMultiplier, color.alphaOffset);
  }
  return rgba;
}

const bitmapFillCanvases = new WeakMap<BitmapDataState, { key: string; canvas: any }>();

/** The bitmap fill pattern source, tinted by the object's colour transform and cached per state. */
function bitmapFillCanvas(state: BitmapDataState, color: ComposedColor): any {
  const key = colorSignature(color);
  const cached = bitmapFillCanvases.get(state);
  if (cached?.key === key) return cached.canvas;
  const scratch = createScratchCanvas(state.width, state.height);
  if (!scratch || typeof scratch.context.putImageData !== "function") return null;
  const rgba = bitmapRgba(state, color);
  const ImageDataCtor = (globalThis as any).ImageData;
  let image: any;
  if (typeof ImageDataCtor === "function") {
    image = new ImageDataCtor(rgba, state.width, state.height);
  } else if (typeof scratch.context.createImageData === "function") {
    image = scratch.context.createImageData(state.width, state.height);
    image.data.set(rgba);
  } else {
    return null;
  }
  scratch.context.putImageData(image, 0, 0);
  bitmapFillCanvases.set(state, { key, canvas: scratch.canvas });
  return scratch.canvas;
}

/** Linear and radial gradients in Flash's 1638.4-unit gradient box, placed by the fill matrix. */
function gradientPaint(context: any, fill: GraphicsGradientFill): any {
  const matrix = graphicsFillMatrix(fill.matrix);
  let gradient: any = null;
  if (fill.type === "radial" && typeof context.createRadialGradient === "function") {
    const scale = Math.hypot(matrix.a, matrix.b) || 1;
    gradient = context.createRadialGradient(
      matrix.tx + fill.focal * GRADIENT_HALF_BOX * matrix.a,
      matrix.ty + fill.focal * GRADIENT_HALF_BOX * matrix.b,
      0, matrix.tx, matrix.ty, GRADIENT_HALF_BOX * scale,
    );
  } else if (typeof context.createLinearGradient === "function") {
    gradient = context.createLinearGradient(
      matrix.tx - GRADIENT_HALF_BOX * matrix.a,
      matrix.ty - GRADIENT_HALF_BOX * matrix.b,
      matrix.tx + GRADIENT_HALF_BOX * matrix.a,
      matrix.ty + GRADIENT_HALF_BOX * matrix.b,
    );
  }
  if (!gradient || typeof gradient.addColorStop !== "function") return null;
  const count = Math.min(fill.colors.length, fill.alphas.length, fill.ratios.length);
  for (let index = 0; index < count; index += 1) {
    const ratio = Math.max(0, Math.min(1, (Number(fill.ratios[index]) || 0) / 255));
    gradient.addColorStop(ratio, rgbaColor(Number(fill.colors[index]) >>> 0, Number(fill.alphas[index] ?? 1)));
  }
  return gradient;
}

function paintFill(context: any, fill: GraphicsFill | null, alpha: number, color: ComposedColor): boolean {
  if (!fill) return false;
  if (fill.kind === "bitmap") {
    if (typeof context.createPattern !== "function") return false;
    const source = bitmapFillCanvas(bitmapDataState(fill.bitmap, "Graphics.beginBitmapFill"), color);
    if (!source) return false;
    const pattern = context.createPattern(source, fill.repeat ? "repeat" : "no-repeat");
    if (!pattern) return false;
    const matrix = graphicsFillMatrix(fill.matrix);
    if (typeof pattern.setTransform === "function") {
      pattern.setTransform({ a: matrix.a, b: matrix.b, c: matrix.c, d: matrix.d, e: matrix.tx, f: matrix.ty });
    }
    context.fillStyle = pattern;
    context.globalAlpha = alpha * color.alphaMultiplier;
    if ("imageSmoothingEnabled" in context) context.imageSmoothingEnabled = fill.smooth && stageAllowsSmoothing;
    return true;
  }
  if (fill.kind === "gradient") {
    const gradient = gradientPaint(context, fill);
    if (!gradient) return false;
    context.fillStyle = gradient;
    context.globalAlpha = alpha * color.alphaMultiplier;
    return true;
  }
  const tinted = tintedColorNumber(fill.color, color);
  const opacity = alpha * fill.alpha * color.alphaMultiplier;
  const identity = isIdentityColor(color);
  context.fillStyle = identity ? cssColor(tinted) : rgbaColor(tinted, opacity);
  context.globalAlpha = identity ? opacity : 1;
  return true;
}

function paintStroke(context: any, stroke: GraphicsStroke | null, alpha: number, color: ComposedColor): boolean {
  if (!stroke) return false;
  const tinted = tintedColorNumber(stroke.color, color);
  const opacity = alpha * stroke.alpha * color.alphaMultiplier;
  const identity = isIdentityColor(color);
  context.strokeStyle = identity ? cssColor(tinted) : rgbaColor(tinted, opacity);
  context.globalAlpha = identity ? opacity : 1;
  context.lineWidth = stroke.thickness;
  return true;
}

function drawGraphics(graphics: any, context: any, alpha: number, color: ComposedColor): void {
  const state = graphicsStates.get(graphics);
  if (!state) return;
  for (const command of state.commands) {
    switch (command.kind) {
      case "rect":
        if (paintFill(context, command.fill, alpha, color)) context.fillRect(command.x, command.y, command.width, command.height);
        if (paintStroke(context, command.stroke, alpha, color)) {
          if (typeof context.strokeRect === "function") context.strokeRect(command.x, command.y, command.width, command.height);
        }
        break;
      case "roundRect": {
        if (paintFill(context, command.fill, alpha, color)) {
          if (typeof context.roundRect === "function") {
            context.beginPath();
            context.roundRect(command.x, command.y, command.width, command.height, [command.ellipseWidth, command.ellipseHeight]);
            context.fill();
          } else {
            context.fillRect(command.x, command.y, command.width, command.height);
          }
        }
        if (paintStroke(context, command.stroke, alpha, color) && typeof context.strokeRect === "function") {
          context.strokeRect(command.x, command.y, command.width, command.height);
        }
        break;
      }
      case "ellipse":
        if (command.fill || command.stroke) {
          context.beginPath();
          context.ellipse(
            command.x + command.width / 2,
            command.y + command.height / 2,
            Math.abs(command.width) / 2,
            Math.abs(command.height) / 2,
            0, 0, Math.PI * 2,
          );
          if (paintFill(context, command.fill, alpha, color)) context.fill();
          if (paintStroke(context, command.stroke, alpha, color)) context.stroke();
        }
        break;
      case "circle":
        if (command.fill || command.stroke) {
          context.beginPath();
          context.arc(command.x, command.y, Math.abs(command.radius), 0, Math.PI * 2);
          if (paintFill(context, command.fill, alpha, color)) context.fill();
          if (paintStroke(context, command.stroke, alpha, color)) context.stroke();
        }
        break;
      case "path":
        if (command.fill || command.stroke) {
          context.beginPath();
          context.moveTo(command.startX, command.startY);
          for (const segment of command.segments) {
            if (segment.kind === "line") context.lineTo(segment.x, segment.y);
            else context.quadraticCurveTo(segment.cx, segment.cy, segment.x, segment.y);
          }
          if (paintFill(context, command.fill, alpha, color)) {
            if (typeof context.closePath === "function") context.closePath();
            context.fill();
          }
          if (paintStroke(context, command.stroke, alpha, color)) context.stroke();
        }
        break;
    }
  }
}

const textFontMetrics = new Map<string, { ascent: number; descent: number }>();

/** Ascent/descent the host reports for a CSS font, in whole pixels like Flash's line metrics. */
function fontMetricsFor(font: string, style: string, weight: string, size: number): { ascent: number; descent: number } {
  const key = `${style}${weight}${size}px ${font}`;
  let metrics = textFontMetrics.get(key);
  if (metrics) return metrics;
  if (!textMeasureContext) textMeasureContext = createScratchCanvas(1, 1)?.context ?? null;
  if (!textMeasureContext) {
    metrics = { ascent: Math.round(size * 0.8), descent: Math.round(size * 0.2) };
  } else {
    textMeasureContext.font = key;
    const measured = textMeasureContext.measureText("Mg");
    metrics = {
      ascent: Math.round(Number(measured.fontBoundingBoxAscent ?? size * 0.8)),
      descent: Math.round(Number(measured.fontBoundingBoxDescent ?? size * 0.2)),
    };
  }
  textFontMetrics.set(key, metrics);
  return metrics;
}

function drawTextField(field: any, context: any, alpha: number, color: ComposedColor): void {
  const text = String(field.text ?? "");
  const format = field.defaultTextFormat ?? field.textFormat ?? null;
  const size = Number(format?.size ?? 12) || 12;
  const font = format?.font ? `"${String(format.font)}", sans-serif` : "sans-serif";
  const weight = format?.bold ? "bold " : "";
  const style = format?.italic ? "italic " : "";
  const align = String(format?.align ?? "left");
  const leading = Number(format?.leading ?? 0) || 0;
  const letterSpacing = Number(format?.letterSpacing ?? 0) || 0;
  const width = Math.max(0, Number(field.width ?? 0));
  const height = Math.max(0, Number(field.height ?? 0));
  // Flash insets text two pixels inside the field and clips it to the field box.
  const gutter = 2;
  const identity = isIdentityColor(color);
  const opacity = alpha * color.alphaMultiplier;
  const textColor = tintedColorNumber(Number(format?.color ?? field.textColor ?? 0), color);
  const paint = (value: number, valueAlpha: number) => {
    context.fillStyle = identity ? cssColor(value) : rgbaColor(value, valueAlpha * color.alphaMultiplier);
    context.globalAlpha = identity ? valueAlpha * color.alphaMultiplier : 1;
  };
  context.font = `${style}${weight}${size}px ${font}`;
  if ("letterSpacing" in context) (context as any).letterSpacing = `${letterSpacing}px`;
  if (field.background && width > 0 && height > 0) {
    paint(tintedColorNumber(Number(field.backgroundColor ?? 0xffffff), color), alpha);
    context.fillRect(0, 0, width, height);
  }
  if (field.border && width > 0 && height > 0) {
    const borderColor = tintedColorNumber(Number(field.borderColor ?? 0), color);
    context.strokeStyle = identity ? cssColor(borderColor) : rgbaColor(borderColor, opacity);
    context.globalAlpha = identity ? opacity : 1;
    context.lineWidth = 1;
    context.strokeRect(0.5, 0.5, Math.max(0, width - 1), Math.max(0, height - 1));
  }
  if (text.length === 0) {
    if ("letterSpacing" in context) (context as any).letterSpacing = "0px";
    return;
  }
  // Flash lays each line ascent + descent tall and draws from the alphabetic baseline.
  const metrics = fontMetricsFor(font, style, weight, size);
  const lineHeight = Math.max(1, metrics.ascent + metrics.descent) + leading;
  let lines = text.split(/\r?\n/);
  if (field.wordWrap && width > 0 && typeof context.measureText === "function") {
    lines = wrappedLines(text, width, gutter, context, lines);
  }
  const clip = width > 0 && height > 0 && typeof context.clip === "function";
  if (clip) {
    context.save();
    context.beginPath();
    context.rect(0, 0, width, height);
    context.clip();
  }
  context.textAlign = align === "center" ? "center" : align === "right" ? "right" : "left";
  context.textBaseline = "alphabetic";
  paint(textColor, alpha);
  const x = align === "center" ? width / 2 : align === "right" ? width - gutter : gutter;
  lines.forEach((line: string, index: number) => {
    context.fillText(line, x, gutter + metrics.ascent + index * lineHeight);
  });
  if (clip) context.restore();
  if ("letterSpacing" in context) (context as any).letterSpacing = "0px";
}

/**
 * Word wrap is measured with `measureText` for every candidate break, and the host re-renders the
 * whole stage each frame, so the wrapped lines are cached per content box and font.
 */
const wrappedLineCache = new Map<string, string[]>();
const WRAPPED_LINE_CACHE_LIMIT = 512;

function wrappedLines(
  text: string,
  width: number,
  gutter: number,
  context: any,
  baseLines: string[],
): string[] {
  const cacheKey = `${context.font ?? ""}|${width}|${text}`;
  const cached = wrappedLineCache.get(cacheKey);
  if (cached) return cached;
  const available = width - gutter * 2;
  // Flash breaks at spaces; a word wider than the line is broken between characters.
  const wrapped: string[] = [];
  for (const line of baseLines) {
    let current = "";
    for (const word of line.split(/(\s+)/)) {
      const next = current + word;
      if (current.length > 0 && context.measureText(next).width > available) {
        wrapped.push(current);
        current = word.trimStart();
      } else {
        current = next;
      }
      while (context.measureText(current).width > available && current.length > 1) {
        let fit = current.length - 1;
        while (fit > 1 && context.measureText(current.slice(0, fit)).width > available) fit -= 1;
        wrapped.push(current.slice(0, fit));
        current = current.slice(fit);
      }
    }
    wrapped.push(current);
  }
  if (wrappedLineCache.size >= WRAPPED_LINE_CACHE_LIMIT) wrappedLineCache.clear();
  wrappedLineCache.set(cacheKey, wrapped);
  return wrapped;
}

function drawBitmap(bitmap: any, context: any, alpha: number, color: ComposedColor): void {
  const state = bitmapDataStates.get(bitmap.bitmapData);
  if (!state || state.width === 0 || state.height === 0) return;
  // Flash does not smooth bitmaps unless Bitmap.smoothing says so, and never at LOW quality.
  context.imageSmoothingEnabled = stageAllowsSmoothing && bitmap.smoothing === true;
  context.globalAlpha = alpha;
  // The common case: upload each bitmap once and blit the cached surface every frame. Hosts that
  // cannot create a scratch canvas fall through to the direct pixel path below.
  if (isIdentityColor(color) && typeof context.drawImage === "function") {
    const surface = bitmapSurface(state);
    if (surface) {
      context.drawImage(surface.canvas, 0, 0);
      return;
    }
  }
  const rgba = bitmapRgba(state, color);
  let image: any = null;
  const ImageDataCtor = (globalThis as any).ImageData;
  if (typeof ImageDataCtor === "function") {
    image = new ImageDataCtor(rgba, state.width, state.height);
  } else if (typeof context.createImageData === "function") {
    image = context.createImageData(state.width, state.height);
    image.data.set(rgba);
  }
  if (!image) throw new AS3RuntimeError("BitmapData.draw", "The host canvas cannot accept ImageData");
  const scratch = createScratchCanvas(state.width, state.height);
  if (scratch && typeof context.drawImage === "function") {
    // putImageData ignores the current transform, so blit through a canvas instead.
    scratch.context.putImageData(image, 0, 0);
    context.drawImage(scratch.canvas, 0, 0);
    return;
  }
  if (typeof context.putImageData !== "function") {
    throw new AS3RuntimeError("BitmapData.draw", "The host canvas cannot accept ImageData");
  }
  context.putImageData(image, 0, 0);
}

/**
 * One upload per bitmap change instead of one per frame: the RGBA conversion and the canvas are
 * both reused until a `BitmapData` writer bumps the version.
 */
function bitmapSurface(state: BitmapDataState): BitmapSurface | null {
  const cached = state.surface;
  if (cached && cached.version === state.version
      && cached.width === state.width && cached.height === state.height) {
    return cached;
  }
  const scratch = cached && cached.width === state.width && cached.height === state.height
    ? cached
    : createScratchCanvas(state.width, state.height);
  if (!scratch) return null;
  const rgba = bitmapRgba(state, IDENTITY_COLOR);
  const ImageDataCtor = (globalThis as any).ImageData;
  let image: any;
  if (typeof ImageDataCtor === "function") {
    image = new ImageDataCtor(rgba, state.width, state.height);
  } else {
    image = scratch.context.createImageData(state.width, state.height);
    image.data.set(rgba);
  }
  scratch.context.putImageData(image, 0, 0);
  const surface: BitmapSurface = {
    canvas: scratch.canvas,
    context: scratch.context,
    version: state.version,
    width: state.width,
    height: state.height,
  };
  state.surface = surface;
  return surface;
}

/** MouseCursor names mapped to CSS cursor keywords; unknown values fall back to `auto`. */
const MOUSE_CURSOR_CSS: Record<string, string> = {
  auto: "auto",
  arrow: "default",
  button: "pointer",
  hand: "pointer",
  ibeam: "text",
};

/** Applies `flash.ui.Mouse` cursor/visibility state to the host canvas, if any. */
function applyMouseCursorState(cursor: string, hidden: boolean): void {
  const documentObject = (globalThis as any).document;
  const canvas = documentObject && typeof documentObject.querySelector === "function"
    ? documentObject.querySelector("canvas")
    : null;
  if (!canvas || !canvas.style) return;
  canvas.style.cursor = hidden ? "none" : (MOUSE_CURSOR_CSS[cursor] ?? "auto");
}

function createScratchCanvas(width: number, height: number): { canvas: any; context: any } | null {
  const OffscreenCanvasCtor = (globalThis as any).OffscreenCanvas;
  if (typeof OffscreenCanvasCtor === "function") {
    const canvas = new OffscreenCanvasCtor(width, height);
    const scratch = canvas.getContext("2d");
    if (scratch) return { canvas, context: scratch };
  }
  const documentObject = (globalThis as any).document;
  if (documentObject && typeof documentObject.createElement === "function") {
    const canvas = documentObject.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const scratch = canvas.getContext("2d");
    if (scratch) return { canvas, context: scratch };
  }
  return null;
}

interface DisplayBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

let textMeasureContext: any = null;

/**
 * Measured prefix widths, per font. Flash fits text to the pixel grid, and the reference client
 * accumulates per-character advances that carry kerning before flooring, so an advance is the
 * difference between two prefixes rather than the width of the glyph alone.
 */
const textPrefixWidths = new Map<string, number>();

function measurePrefixWidth(context: any, font: string, prefix: string): number {
  // A tab advances four spaces, as it did in the player.
  const probe = prefix.replace(/\t/g, "    ");
  const key = font + "|" + probe;
  const cached = textPrefixWidths.get(key);
  if (cached !== undefined) return cached;
  const measured = Number(context.measureText(probe).width);
  if (textPrefixWidths.size > 8192) textPrefixWidths.clear();
  textPrefixWidths.set(key, measured);
  return measured;
}

function measureTextLine(context: any, font: string, line: string, letterSpacing: number): number {
  let width = 0;
  let prefix = "";
  let prefixWidth = 0;
  for (const character of line) {
    const next = prefix + character;
    const nextWidth = measurePrefixWidth(context, font, next);
    width += Math.round(nextWidth - prefixWidth) + letterSpacing;
    prefix = next;
    prefixWidth = nextWidth;
  }
  return width;
}

function displayFqcn(value: any): string {
  return value?.constructor?.$fqcn ?? value?.constructor?.$desc?.name ?? "";
}

function isStageDisplayObject(value: any): boolean {
  return displayFqcn(value) === "flash.display.Stage";
}

function textFieldMetrics(field: any): { width: number; height: number } {
  const text = String(field?.text ?? "");
  if (text.length === 0) return { width: 0, height: 0 };
  const format = field.defaultTextFormat ?? null;
  const size = Math.max(1, Number(format?.size ?? 12) || 12);
  const font = format?.font ? `"${String(format.font)}", sans-serif` : "sans-serif";
  const weight = format?.bold ? "bold " : "";
  const style = format?.italic ? "italic " : "";
  const lines = text.split(/\r?\n/);
  const leading = Number(format?.leading ?? 0) || 0;
  const letterSpacing = Number(format?.letterSpacing ?? 0) || 0;
  if (!textMeasureContext) textMeasureContext = createScratchCanvas(1, 1)?.context ?? null;
  const cssFont = `${style}${weight}${size}px ${font}`;
  let width = 0;
  if (textMeasureContext) {
    textMeasureContext.font = cssFont;
    if ("letterSpacing" in textMeasureContext) textMeasureContext.letterSpacing = "0px";
    width = Math.max(...lines.map((line: string) => measureTextLine(textMeasureContext, cssFont, line, letterSpacing)));
  } else {
    // No canvas to measure with: every character advances by the same whole number of pixels.
    const advance = Math.round(size * 0.55);
    width = Math.max(...lines.map((line: string) => line.length * (advance + letterSpacing)));
  }
  const metrics = fontMetricsFor(font, style, weight, size);
  const lineHeight = Math.max(1, metrics.ascent + metrics.descent) + leading;
  return { width, height: lines.length * lineHeight };
}

function graphicsContentBounds(graphics: any): DisplayBounds | null {
  const state = graphicsStates.get(graphics);
  if (!state) return null;
  let left = Infinity;
  let top = Infinity;
  let right = -Infinity;
  let bottom = -Infinity;
  const include = (x: number, y: number, width = 0, height = 0): void => {
    left = Math.min(left, x, x + width);
    top = Math.min(top, y, y + height);
    right = Math.max(right, x, x + width);
    bottom = Math.max(bottom, y, y + height);
  };
  for (const command of state.commands) {
    switch (command.kind) {
      case "rect":
      case "roundRect":
      case "ellipse":
        include(command.x, command.y, command.width, command.height);
        break;
      case "circle":
        include(command.x - command.radius, command.y - command.radius, command.radius * 2, command.radius * 2);
        break;
      case "path":
        include(command.startX, command.startY);
        for (const segment of command.segments) {
          include(segment.x, segment.y);
          if (segment.kind === "curve") include(segment.cx, segment.cy);
        }
        break;
    }
  }
  if (!Number.isFinite(left)) return null;
  return { x: left, y: top, width: right - left, height: bottom - top };
}

function contentBounds(target: any): DisplayBounds | null {
  if (!target) return null;
  const fqcn = displayFqcn(target);
  if (target.bitmapData) {
    const state = bitmapDataStates.get(target.bitmapData);
    if (state) return { x: 0, y: 0, width: state.width, height: state.height };
    return null;
  }
  if (fqcn === "flash.text.TextField") {
    const metrics = textFieldMetrics(target);
    return metrics.width > 0 || metrics.height > 0
      ? { x: 0, y: 0, width: metrics.width, height: metrics.height }
      : null;
  }
  let bounds = target.graphics ? graphicsContentBounds(target.graphics) : null;
  const children = Array.isArray(target.__children) ? target.__children : [];
  for (const child of children) {
    const childBounds = contentBounds(child);
    if (!childBounds) continue;
    // A child's bounds reach this container through the child's own scale and rotation.
    const placed = transformBounds(childBounds, child);
    const x = Number(child.x ?? 0) + placed.x;
    const y = Number(child.y ?? 0) + placed.y;
    const width = placed.width;
    const height = placed.height;
    if (!bounds) bounds = { x, y, width, height };
    else {
      const left = Math.min(bounds.x, x);
      const top = Math.min(bounds.y, y);
      const right = Math.max(bounds.x + bounds.width, x + width);
      const bottom = Math.max(bounds.y + bounds.height, y + height);
      bounds = { x: left, y: top, width: right - left, height: bottom - top };
    }
  }
  return bounds;
}

// A rectangle through a display object's own scale and rotation, as Flash does for getBounds.
function transformBounds(
  local: DisplayBounds,
  target: any,
): DisplayBounds {
  const scaleX = Number(target?.scaleX ?? 1);
  const scaleY = Number(target?.scaleY ?? 1);
  const radians = ((Number(target?.rotation ?? 0) || 0) * Math.PI) / 180;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  const corners: Array<[number, number]> = [
    [local.x, local.y],
    [local.x + local.width, local.y],
    [local.x, local.y + local.height],
    [local.x + local.width, local.y + local.height],
  ].map(([x, y]) => {
    const scaledX = x * scaleX;
    const scaledY = y * scaleY;
    return [scaledX * cos - scaledY * sin, scaledX * sin + scaledY * cos];
  });
  const xs = corners.map((corner) => corner[0]);
  const ys = corners.map((corner) => corner[1]);
  const left = Math.min(...xs);
  const top = Math.min(...ys);
  return { x: left, y: top, width: Math.max(...xs) - left, height: Math.max(...ys) - top };
}

function displayWidth(target: any): number {
  if (isStageDisplayObject(target)) return Math.max(0, Number(target.stageWidth) || 0);
  if (displayFqcn(target) === "flash.text.TextField") {
    if (target.autoSize && target.autoSize !== "none") {
      const metrics = textFieldMetrics(target);
      // Flash's autoSize box adds the two-pixel gutter on both sides.
      if (metrics.width > 0) return metrics.width + 4;
    }
    if (target.__explicitWidth !== null && target.__explicitWidth !== undefined) {
      return Math.max(0, Number(target.__explicitWidth) || 0);
    }
  }
  const bounds = contentBounds(target);
  return Math.max(0, bounds ? bounds.width * Math.abs(Number(target.scaleX ?? 1)) : 0);
}

function displayHeight(target: any): number {
  if (isStageDisplayObject(target)) return Math.max(0, Number(target.stageHeight) || 0);
  if (displayFqcn(target) === "flash.text.TextField") {
    if (target.autoSize && target.autoSize !== "none") {
      const metrics = textFieldMetrics(target);
      if (metrics.height > 0) return metrics.height + 4;
    }
    if (target.__explicitHeight !== null && target.__explicitHeight !== undefined) {
      return Math.max(0, Number(target.__explicitHeight) || 0);
    }
  }
  const bounds = contentBounds(target);
  return Math.max(0, bounds ? bounds.height * Math.abs(Number(target.scaleY ?? 1)) : 0);
}

function setDisplayWidth(target: any, value: any): void {
  const next = Math.max(0, Number(value) || 0);
  // The stage is sized by the player; Flash's Stage.width is read-only.
  if (isStageDisplayObject(target)) return;
  // A TextField's width is its text box, not a scale.
  if (displayFqcn(target) === "flash.text.TextField") {
    target.__explicitWidth = next;
    return;
  }
  // Flash scales the object: the unrotated content ends up `value` wide.
  const local = contentBounds(target)?.width ?? 0;
  if (local === 0) return;
  target.scaleX = next / local;
}

function setDisplayHeight(target: any, value: any): void {
  const next = Math.max(0, Number(value) || 0);
  if (isStageDisplayObject(target)) return;
  if (displayFqcn(target) === "flash.text.TextField") {
    target.__explicitHeight = next;
    return;
  }
  const local = contentBounds(target)?.height ?? 0;
  if (local === 0) return;
  target.scaleY = next / local;
}

function htmlToText(value: any): string {
  return String(value ?? "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]*>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'");
}

/** Draws a display list through a host canvas 2D context (shape graphics, text and bitmaps). */
/** The object's own transform matrix, composed the way Flash renders x/y/rotation/scale. */
function displayObjectMatrix(object: any): any {
  const rotation = (Number(object.rotation ?? 0) * Math.PI) / 180;
  const cos = Math.cos(rotation);
  const sin = Math.sin(rotation);
  const scaleX = Number(object.scaleX ?? 1);
  const scaleY = Number(object.scaleY ?? 1);
  return runtimeNew(
    "flash.geom.Matrix",
    cos * scaleX,
    sin * scaleX,
    -sin * scaleY,
    cos * scaleY,
    Number(object.x ?? 0),
    Number(object.y ?? 0),
  );
}

/** `transform.matrix = m` decomposes into the fields the display list renders from. */
function applyDisplayObjectMatrix(object: any, matrix: any): void {
  const a = Number(matrix.a ?? 1);
  const b = Number(matrix.b ?? 0);
  const c = Number(matrix.c ?? 0);
  const d = Number(matrix.d ?? 1);
  const scaleX = Math.hypot(a, b);
  object.rotation = (Math.atan2(b, a) * 180) / Math.PI;
  object.scaleX = scaleX;
  object.scaleY = scaleX === 0 ? Math.hypot(c, d) : (a * d - b * c) / scaleX;
  object.x = Number(matrix.tx ?? 0);
  object.y = Number(matrix.ty ?? 0);
}

/** Product of the ancestor matrices down to the object, as Flash reports it. */
function concatenatedDisplayMatrix(object: any): any {
  const chain: any[] = [];
  for (let node = object; node; node = node.__parent) chain.push(node);
  let result: any = displayObjectMatrix(chain[chain.length - 1] ?? object);
  for (let index = chain.length - 2; index >= 0; index -= 1) {
    const next = displayObjectMatrix(chain[index]);
    // result = result * next: the ancestor's transform applies after the descendant's.
    const a = result.a * next.a + result.c * next.b;
    const b = result.b * next.a + result.d * next.b;
    const c = result.a * next.c + result.c * next.d;
    const d = result.b * next.c + result.d * next.d;
    const tx = result.a * next.tx + result.c * next.ty + result.tx;
    const ty = result.b * next.tx + result.d * next.ty + result.ty;
    result = runtimeNew("flash.geom.Matrix", a, b, c, d, tx, ty);
  }
  return result;
}

// Flash only smooths bitmaps at HIGH/BEST quality; StageQuality.LOW renders them unfiltered.
let stageAllowsSmoothing = true;

export function $renderDisplay(root: any, context: any, alpha = 1): void {
  if (!root || root.visible === false) return;
  if (typeof context?.save !== "function" || typeof context?.restore !== "function") {
    throw new AS3RuntimeError("$renderDisplay", "A canvas 2D rendering context is required");
  }
  const previousSmoothing = stageAllowsSmoothing;
  stageAllowsSmoothing = String(root?.quality ?? "high").toLowerCase() !== "low";
  try {
    renderDisplayNode(root, context, IDENTITY_COLOR, alpha, "normal", true);
  } finally {
    stageAllowsSmoothing = previousSmoothing;
  }
}

/**
 * One display object: colour transforms and blend modes accumulate down the tree the way
 * Flash applies them, and each node draws with its own x/y/rotation/scale.
 */
function renderDisplayNode(
  node: any,
  context: any,
  parentColor: ComposedColor,
  parentAlpha: number,
  parentBlend: string,
  isRoot: boolean,
): void {
  if (!isRoot && node.visible === false) return;
  context.save();
  context.translate(Number(node.x ?? 0), Number(node.y ?? 0));
  if (Number(node.rotation ?? 0) !== 0) context.rotate((Number(node.rotation) * Math.PI) / 180);
  const scaleX = Number(node.scaleX ?? 1);
  const scaleY = Number(node.scaleY ?? 1);
  if (scaleX !== 1 || scaleY !== 1) context.scale(scaleX, scaleY);
  const color = concatColor(parentColor, colorOf(node.__colorTransform));
  const ownAlpha = parentAlpha * Number(node.alpha ?? 1);
  const blend =
    typeof node.blendMode === "string" && node.blendMode !== "normal" ? node.blendMode : parentBlend;
  const composite = canvasCompositeOperation(blend);
  if (composite !== "source-over" && "globalCompositeOperation" in context) {
    context.globalCompositeOperation = composite;
  }
  if (node.graphics) drawGraphics(node.graphics, context, ownAlpha, color);
  if ($is(node, $runtimeClass("flash.text.TextField"))) drawTextField(node, context, ownAlpha, color);
  else if ($is(node, $runtimeClass("flash.display.Bitmap"))) drawBitmap(node, context, ownAlpha, color);
  for (const child of node.__children ?? []) {
    renderDisplayNode(child, context, color, ownAlpha, blend, false);
  }
  context.restore();
}

/* ------------------------------------------------------------------ *
 * Runtime `.pop` archives and the asset manager
 * ------------------------------------------------------------------ */

export interface RuntimePopAsset {
  name: string;
  source: string;
  entry: string;
  mime: string;
  kind: string;
  size: number;
  sha256: string;
  aliases?: string[];
  compression?: "store" | "deflate";
}

export interface RuntimePopManifest {
  format: "as3js-pop";
  version: 1;
  abi: 1;
  bundle: string;
  compiler: string;
  created: string;
  modules: string[];
  dependencies: string[];
  assets: RuntimePopAsset[];
}

const POP_CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
})();

function popCrc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of data) crc = POP_CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function decodePopText(data: Uint8Array): string {
  return new TextDecoder().decode(data);
}

function parsePopArchive(bytes: Uint8Array): { manifest: RuntimePopManifest; entries: Map<string, Uint8Array> } {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let endOffset = -1;
  for (let offset = bytes.length - 22; offset >= 0; offset -= 1) {
    if (view.getUint32(offset, true) === 0x06054b50) {
      endOffset = offset;
      break;
    }
  }
  if (endOffset < 0) throw new AS3RuntimeError("PopArchive", "End of central directory not found");
  const count = view.getUint16(endOffset + 10, true);
  const centralOffset = view.getUint32(endOffset + 16, true);
  const entries = new Map<string, Uint8Array>();
  let cursor = centralOffset;
  for (let index = 0; index < count; index += 1) {
    if (cursor + 46 > bytes.length || view.getUint32(cursor, true) !== 0x02014b50) {
      throw new AS3RuntimeError("PopArchive", "Invalid central directory entry");
    }
    const method = view.getUint16(cursor + 10, true);
    const crc = view.getUint32(cursor + 16, true);
    const compressedSize = view.getUint32(cursor + 20, true);
    const uncompressedSize = view.getUint32(cursor + 24, true);
    const nameLength = view.getUint16(cursor + 28, true);
    const extraLength = view.getUint16(cursor + 30, true);
    const commentLength = view.getUint16(cursor + 32, true);
    const localOffset = view.getUint32(cursor + 42, true);
    const name = decodePopText(bytes.subarray(cursor + 46, cursor + 46 + nameLength));
    if (method !== 0 && method !== 8) {
      throw new AS3RuntimeError("PopArchive", `Unsupported compression method ${method} for ${name}`);
    }
    if (!name || name.startsWith("/") || name.split("/").includes("..") || name.includes("\\")) {
      throw new AS3RuntimeError("PopArchive", `Unsafe archive entry '${name}'`);
    }
    if (localOffset + 30 > bytes.length || view.getUint32(localOffset, true) !== 0x04034b50) {
      throw new AS3RuntimeError("PopArchive", `Invalid local header for ${name}`);
    }
    const localNameLength = view.getUint16(localOffset + 26, true);
    const localExtraLength = view.getUint16(localOffset + 28, true);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    if (dataStart + compressedSize > bytes.length) {
      throw new AS3RuntimeError("PopArchive", `Truncated archive entry ${name}`);
    }
    const compressed = bytes.slice(dataStart, dataStart + compressedSize);
    const data = method === 8 ? inflateRaw(compressed) : compressed;
    if (data.length !== uncompressedSize) {
      throw new AS3RuntimeError("PopArchive", `Size mismatch in ${name}`);
    }
    if (popCrc32(data) !== crc) throw new AS3RuntimeError("PopArchive", `CRC mismatch in ${name}`);
    entries.set(name, data);
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  const manifestBytes = entries.get("pop.json");
  if (!manifestBytes) throw new AS3RuntimeError("PopArchive", "pop.json is missing");
  let manifest: RuntimePopManifest;
  try {
    manifest = JSON.parse(decodePopText(manifestBytes)) as RuntimePopManifest;
  } catch (error) {
    throw new AS3RuntimeError("PopArchive", `Invalid pop.json: ${(error as Error).message}`);
  }
  if (manifest.format !== "as3js-pop" || manifest.version !== 1 || manifest.abi !== 1) {
    throw new AS3RuntimeError("PopArchive", "Unsupported .pop manifest format or version");
  }
  if (!Array.isArray(manifest.assets)) throw new AS3RuntimeError("PopArchive", "pop.json has no asset list");
  return { manifest, entries };
}

/** A parsed, deterministic `.pop` archive fetched or created at runtime. */
export class PopArchive {
  readonly manifest: RuntimePopManifest;
  readonly entries: Map<string, Uint8Array>;
  private readonly byName = new Map<string, RuntimePopAsset>();

  private constructor(manifest: RuntimePopManifest, entries: Map<string, Uint8Array>) {
    this.manifest = manifest;
    this.entries = entries;
    for (const asset of manifest.assets) {
      this.byName.set(asset.name, asset);
      this.byName.set(asset.source, asset);
      this.byName.set(asset.entry, asset);
      for (const alias of asset.aliases ?? []) this.byName.set(alias, asset);
    }
  }

  static fromBytes(bytes: Uint8Array): PopArchive {
    const parsed = parsePopArchive(bytes);
    return new PopArchive(parsed.manifest, parsed.entries);
  }

  static async load(url: string, init?: any): Promise<PopArchive> {
    if (typeof fetch !== "function") {
      throw new AS3RuntimeError("PopArchive.load", "This host has no fetch implementation");
    }
    const response = await fetch(url, init);
    if (!response.ok) throw new AS3RuntimeError("PopArchive.load", `HTTP ${response.status} for ${url}`);
    return PopArchive.fromBytes(new Uint8Array(await response.arrayBuffer()));
  }

  asset(name: string): RuntimePopAsset | null {
    return this.byName.get(String(name)) ?? null;
  }

  get(name: string): Uint8Array | null {
    const asset = this.asset(name);
    if (asset) return this.entries.get(asset.entry) ?? null;
    return this.entries.get(String(name)) ?? null;
  }

  require(name: string): Uint8Array {
    const bytes = this.get(name);
    if (!bytes) throw new AS3RuntimeError("PopArchive.get", `Asset '${name}' was not found in ${this.manifest.bundle}`);
    return bytes;
  }

  text(name: string): string {
    return decodePopText(this.require(name));
  }

  json(name: string): any {
    return JSON.parse(this.text(name));
  }

  xml(name: string): any {
    const XML = $runtimeClass("XML");
    return new XML(this.text(name));
  }
}

/** Loads bundles by name and resolves assets across them. */
export class AssetManager {
  private readonly bundles = new Map<string, PopArchive>();
  private readonly pending = new Map<string, Promise<PopArchive>>();

  async loadBundle(name: string, url: string, init?: any): Promise<PopArchive> {
    const existing = this.pending.get(name);
    if (existing) return existing;
    const loading = PopArchive.load(url, init).then((archive) => {
      this.bundles.set(name, archive);
      return archive;
    }).finally(() => this.pending.delete(name));
    this.pending.set(name, loading);
    return loading;
  }

  addBundle(name: string, archive: PopArchive): void {
    this.bundles.set(name, archive);
  }

  isBundleLoaded(name: string): boolean {
    return this.bundles.has(name);
  }

  archive(name: string): PopArchive | null {
    return this.bundles.get(name) ?? null;
  }

  get(name: string): Uint8Array | null {
    for (const archive of this.bundles.values()) {
      const bytes = archive.get(name);
      if (bytes) return bytes;
    }
    return null;
  }

  getBytes(name: string): Uint8Array | null {
    return this.get(name);
  }

  getText(name: string): string | null {
    const bytes = this.get(name);
    return bytes ? decodePopText(bytes) : null;
  }

  getXml(name: string): any {
    const text = this.getText(name);
    if (text === null) return null;
    const XML = $runtimeClass("XML");
    return new XML(text);
  }
}

export function $loadPop(url: string, init?: any): Promise<PopArchive> {
  return PopArchive.load(url, init);
}

let embeddedAssetManager: AssetManager | null = null;
const embeddedBitmapJobs: Promise<void>[] = [];

/** Host hook: installs the manager used by generated `[Embed]` asset classes. */
export function $setAssetManager(manager: AssetManager | null): void {
  embeddedAssetManager = manager;
}

export function $getAssetManager(): AssetManager | null {
  return embeddedAssetManager;
}

/** Waits for browser image decoding started by `[Embed]` bitmap classes. */
export async function $flushEmbeddedAssets(): Promise<void> {
  while (embeddedBitmapJobs.length > 0) {
    const jobs = embeddedBitmapJobs.splice(0);
    await Promise.all(jobs);
  }
}

function embeddedMetadataArgument(C: any, name: string): any {
  const metadata = C?.$desc?.metadata;
  if (!Array.isArray(metadata)) return undefined;
  const embed = metadata.find((item: any) => String(item?.name).toLowerCase() === "embed");
  const args = embed?.args;
  if (!Array.isArray(args)) return undefined;
  return args.find((item: any) => item?.name === name)?.value;
}

function embeddedBaseFqcn(C: any): string | null {
  let current = C?.$desc?.base?.();
  while (current) {
    if (typeof current.$fqcn === "string") return current.$fqcn;
    current = current.$desc?.base?.();
  }
  return null;
}

function pngDimensions(bytes: Uint8Array): { width: number; height: number } {
  if (
    bytes.length >= 24 &&
    bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 &&
    bytes[12] === 0x49 && bytes[13] === 0x48 && bytes[14] === 0x44 && bytes[15] === 0x52
  ) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const width = view.getUint32(16, false);
    const height = view.getUint32(20, false);
    if (width > 0 && height > 0) return { width, height };
  }
  return { width: 1, height: 1 };
}

/** Writes decoded pixels into a BitmapData and the display object that owns it. */
function setBitmapDataPixels(
  target: any,
  bitmapData: any,
  width: number,
  height: number,
  pixels: Uint32Array,
): void {
  const state = bitmapDataStates.get(bitmapData);
  if (state) {
    state.width = width;
    state.height = height;
    state.pixels = pixels;
  }
  bitmapData.width = width;
  bitmapData.height = height;
  bitmapData.rect = runtimeNew("flash.geom.Rectangle", 0, 0, width, height);
  target.width = width;
  target.height = height;
}

function decodeEmbeddedBitmap(target: any, bitmapData: any, bytes: Uint8Array): void {
  const createImageBitmap = (globalThis as any).createImageBitmap;
  const BlobCtor = (globalThis as any).Blob;
  if (typeof createImageBitmap !== "function" || typeof BlobCtor !== "function") return;
  const job = createImageBitmap(new BlobCtor([bytes], { type: "image/png" }))
    .then((image: any) => {
      const width = Number(image.width ?? 0);
      const height = Number(image.height ?? 0);
      const scratch = createScratchCanvas(width, height);
      if (!scratch || width <= 0 || height <= 0) return;
      scratch.context.drawImage(image, 0, 0);
      const imageData = scratch.context.getImageData(0, 0, width, height);
      const pixels = new Uint32Array(width * height);
      for (let index = 0; index < pixels.length; index += 1) {
        pixels[index] = (
          (imageData.data[index * 4 + 3]! << 24) |
          (imageData.data[index * 4]! << 16) |
          (imageData.data[index * 4 + 1]! << 8) |
          imageData.data[index * 4 + 2]!
        ) >>> 0;
      }
      setBitmapDataPixels(target, bitmapData, width, height, pixels);
      image.close?.();
    })
    .catch(() => undefined);
  embeddedBitmapJobs.push(job);
}

/* ------------------------------------------------------------------ *
 * SWF asset libraries
 * ------------------------------------------------------------------ */

const swfDomainDefinitions = new WeakMap<object, Map<string, any>>();
let swfSyntheticClassCount = 0;

function swfDefinitions(domain: any): Map<string, any> {
  if (!domain || typeof domain !== "object") return new Map();
  let definitions = swfDomainDefinitions.get(domain);
  if (!definitions) {
    definitions = new Map();
    swfDomainDefinitions.set(domain, definitions);
  }
  return definitions;
}

/** Creates a class for a loaded SWF symbol without touching the global registry. */
function swfClass(fqcn: string, base: any, init: (target: any) => void): any {
  swfSyntheticClassCount += 1;
  const name = fqcn.length > 0 ? fqcn : `swf.symbol.${swfSyntheticClassCount}`;
  function SwfClass(this: any, ...args: any[]) {
    return $construct(SwfClass, args);
  }
  Object.setPrototypeOf(SwfClass, base);
  SwfClass.prototype = Object.create(base.prototype);
  Object.defineProperty(SwfClass.prototype, "constructor", {
    value: SwfClass,
    writable: true,
    configurable: true,
  });
  Object.defineProperties(SwfClass, {
    $fqcn: { value: name, writable: true, configurable: true },
    $interfaces: { value: [], writable: true, configurable: true },
    $initialized: { value: true, writable: true, configurable: true },
    $desc: {
      value: {
        name,
        abi: ABI_VERSION,
        base: () => base,
        interfaces: () => [],
        flags: { final: false, dynamic: false },
        metadata: [],
        fields: {},
        methods: {},
        statics: {},
        staticValues: {},
        ctor: {
          params: [],
          fn: function(this: any, ...args: any[]) {
            $super(this, base, args);
            init(this);
          },
        },
      },
      writable: true,
      configurable: true,
    },
  });
  return SwfClass;
}

function swfByteArrayClass(fqcn: string, content?: Uint8Array): any {
  const ByteArray = $runtimeClass("flash.utils.ByteArray");
  return swfClass(fqcn, ByteArray, (target) => {
    const bytes = content ?? new Uint8Array(0);
    const storage = new Uint8Array(Math.max(16, bytes.length));
    storage.set(bytes);
    byteArrayStates.set(target, {
      bytes: storage,
      view: new DataView(storage.buffer),
      length: bytes.length,
      position: 0,
      little: false,
      objectEncoding: 3,
    });
  });
}

function jpegDimensions(bytes: Uint8Array): { width: number; height: number } {
  let offset = 2;
  while (offset + 8 <= bytes.length) {
    if (bytes[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    const marker = bytes[offset + 1]!;
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2;
      continue;
    }
    const length = (bytes[offset + 2]! << 8) | bytes[offset + 3]!;
    if (length < 2) break;
    const isFrameHeader =
      marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isFrameHeader) {
      const height = (bytes[offset + 5]! << 8) | bytes[offset + 6]!;
      const width = (bytes[offset + 7]! << 8) | bytes[offset + 8]!;
      if (width > 0 && height > 0) return { width, height };
      break;
    }
    offset += 2 + length;
  }
  return { width: 1, height: 1 };
}

function swfImageDimensions(image: SwfImage): { width: number; height: number } {
  if (image.width > 0 && image.height > 0) return { width: image.width, height: image.height };
  if (!image.bytes) return { width: 1, height: 1 };
  return image.mimeType === "image/jpeg" ? jpegDimensions(image.bytes) : pngDimensions(image.bytes);
}

async function swfDecodeImage(bitmapData: any, bytes: Uint8Array, mimeType: string): Promise<void> {
  const createImageBitmap = (globalThis as any).createImageBitmap;
  const BlobCtor = (globalThis as any).Blob;
  if (typeof createImageBitmap !== "function" || typeof BlobCtor !== "function") return;
  const image = await createImageBitmap(new BlobCtor([bytes], { type: mimeType }));
  const width = Number(image.width ?? 0);
  const height = Number(image.height ?? 0);
  const scratch = createScratchCanvas(width, height);
  if (!scratch || width <= 0 || height <= 0) return;
  scratch.context.drawImage(image, 0, 0);
  const imageData = scratch.context.getImageData(0, 0, width, height);
  const pixels = new Uint32Array(width * height);
  for (let index = 0; index < pixels.length; index += 1) {
    pixels[index] = (
      (imageData.data[index * 4 + 3]! << 24) |
      (imageData.data[index * 4]! << 16) |
      (imageData.data[index * 4 + 1]! << 8) |
      imageData.data[index * 4 + 2]!
    ) >>> 0;
  }
  const state = bitmapDataStates.get(bitmapData);
  if (!state) return;
  state.width = width;
  state.height = height;
  state.pixels = pixels;
  bitmapData.width = width;
  bitmapData.height = height;
  bitmapData.rect = runtimeNew("flash.geom.Rectangle", 0, 0, width, height);
  image.close?.();
}

function swfBitmapData(image: SwfImage): any {
  const size = swfImageDimensions(image);
  const bitmapData = runtimeNew("flash.display.BitmapData", size.width, size.height, true);
  const state = bitmapDataStates.get(bitmapData);
  if (state && image.pixels && image.pixels.length === state.pixels.length) state.pixels = image.pixels;
  if (image.bytes) {
    const mimeType = image.mimeType ?? "application/octet-stream";
    embeddedBitmapJobs.push(swfDecodeImage(bitmapData, image.bytes, mimeType).catch(() => undefined));
  }
  return bitmapData;
}

function swfBitmapClass(fqcn: string, image: SwfImage): any {
  const Bitmap = $runtimeClass("flash.display.Bitmap");
  return swfClass(fqcn, Bitmap, (target) => {
    target.bitmapData = swfBitmapData(image);
  });
}

/** Registers one library SWF's symbols in the given application domains. */
function swfInstallLibrary(library: SwfLibrary, domains: any[], libraryName: string): void {
  const MovieClip = $runtimeClass("flash.display.MovieClip");
  const assets = new Map<string, any>();
  let manifestClass: any = null;
  for (const symbol of library.symbols) {
    const C =
      symbol.kind === "binary" && symbol.bytes
        ? swfByteArrayClass(symbol.className ?? "", symbol.bytes)
        : symbol.image
          ? swfBitmapClass(symbol.className ?? "", symbol.image)
          : null;
    if (!C) continue;
    if (!manifestClass && symbol.bytes && symbol.bytes === library.manifest) manifestClass = C;
    if (symbol.className) assets.set(symbol.className, C);
  }
  if (!manifestClass) {
    manifestClass = swfByteArrayClass(`${libraryName}_manifest`, library.manifest ?? undefined);
  }

  const root = swfClass(libraryName, MovieClip, () => {});
  // Flash library SWFs export symbols as `<library>_<asset>`, while their manifests
  // reference the short `<asset>` name; the resource class exposes both.
  const prefix = libraryName.length > 0 ? `${libraryName}_` : "";
  const resource = new Map<string, any>();
  for (const [name, assetClass] of assets) {
    resource.set(name, assetClass);
    if (prefix.length > 0 && name.startsWith(prefix) && name.length > prefix.length) {
      resource.set(name.slice(prefix.length), assetClass);
    }
  }
  Object.defineProperty(root, "manifest", {
    value: manifestClass,
    writable: true,
    configurable: true,
    enumerable: true,
  });
  for (const [name, assetClass] of resource) {
    if (name === "manifest") continue;
    Object.defineProperty(root, name, {
      value: assetClass,
      writable: true,
      configurable: true,
      enumerable: true,
    });
  }
  for (const domain of domains) {
    if (!domain || typeof domain !== "object") continue;
    const definitions = swfDefinitions(domain);
    for (const [name, assetClass] of resource) definitions.set(name, assetClass);
    if (libraryName.length > 0) definitions.set(libraryName, root);
  }
}

function swfByteArrayContent(value: any): Uint8Array {
  if (value instanceof Uint8Array) return value;
  const state = byteArrayStates.get(value);
  if (!state) throw new AS3RuntimeError("flash.display.Loader.loadBytes", "A ByteArray is required");
  return state.bytes.slice(0, state.length);
}

function swfLinkLoader(loader: any, bytes: Uint8Array, url: string, domain: any): void {
  let library: SwfLibrary;
  try {
    library = parseSwf(bytes);
  } catch (error) {
    throw new Error(`Failed to read SWF library '${url}': ${(error as any)?.message ?? error}`);
  }
  const info = loader.contentLoaderInfo;
  const libraryName = swfLibraryName(url);
  swfInstallLibrary(library, [domain, info.applicationDomain], libraryName);
  const content = runtimeNew("flash.display.MovieClip");
  content.name = libraryName;
  content.loaderInfo = info;
  info.content = content;
  loader.content = content;
}

function swfLibraryName(url: string): string {
  const withoutQuery = url.split(/[?#]/)[0] ?? url;
  const file = withoutQuery.slice(withoutQuery.lastIndexOf("/") + 1);
  const dot = file.lastIndexOf(".");
  return dot > 0 ? file.slice(0, dot) : file;
}

function swfRequestUrl(request: any): string {
  if (typeof request === "string") return request;
  const url = request?.url;
  return typeof url === "string" ? url : "";
}

/** Resolves a request URL against the host base (Flash `base` embed parameter) or page URL. */
function runtimeResolveUrl(url: string): string {
  const locationHref = (globalThis as any).location?.href;
  let base = typeof locationHref === "string" ? locationHref : "";
  if (externalBaseUrl.length > 0) {
    try {
      base = typeof locationHref === "string" ? new URL(externalBaseUrl, locationHref).href : externalBaseUrl;
    } catch {
      base = externalBaseUrl;
    }
  }
  if (base.length === 0) return url;
  try {
    return new URL(url, base).href;
  } catch {
    return url;
  }
}

function swfLoad(loader: any, request: any, context?: any): void {
  const info = loader.contentLoaderInfo;
  const url = runtimeResolveUrl(swfRequestUrl(request));
  const domain = context?.applicationDomain ?? info.applicationDomain ?? currentApplicationDomain();
  const Event = $runtimeClass("flash.events.Event");
  const ProgressEvent = $runtimeClass("flash.events.ProgressEvent");
  const HTTPStatusEvent = $runtimeClass("flash.events.HTTPStatusEvent");
  const IOErrorEvent = $runtimeClass("flash.events.IOErrorEvent");
  loader.__swfAbort?.abort?.();
  const controller = typeof AbortController === "function" ? new AbortController() : null;
  loader.__swfAbort = controller;
  info.url = url;
  info.loaderURL = url;
  info.bytesLoaded = 0;
  info.bytesTotal = 0;
  const failed = (message: string) => {
    info.dispatchEvent(new IOErrorEvent(IOErrorEvent.IO_ERROR, false, false, message));
  };
  void (async () => {
    try {
      const response = await fetch(url, controller ? { signal: controller.signal } : undefined);
      info.dispatchEvent(
        new HTTPStatusEvent(HTTPStatusEvent.HTTP_STATUS, false, false, response.status),
      );
      if (!response.ok) {
        failed(`HTTP ${response.status} while loading ${url}`);
        return;
      }
      const bytes = new Uint8Array(await response.arrayBuffer());
      info.bytesLoaded = bytes.length;
      info.bytesTotal = bytes.length;
      info.dispatchEvent(
        new ProgressEvent(ProgressEvent.PROGRESS, false, false, bytes.length, bytes.length),
      );
      swfLinkLoader(loader, bytes, url, domain);
      info.dispatchEvent(new Event(Event.INIT));
      info.dispatchEvent(new Event(Event.COMPLETE));
    } catch (error) {
      if ((error as any)?.name === "AbortError") return;
      failed(String((error as any)?.message ?? error));
    }
  })();
}

function swfLoadBytes(loader: any, data: any, context?: any): void {
  const info = loader.contentLoaderInfo;
  const domain = context?.applicationDomain ?? info.applicationDomain ?? currentApplicationDomain();
  const Event = $runtimeClass("flash.events.Event");
  const IOErrorEvent = $runtimeClass("flash.events.IOErrorEvent");
  let bytes: Uint8Array;
  try {
    bytes = swfByteArrayContent(data);
    info.bytesLoaded = bytes.length;
    info.bytesTotal = bytes.length;
    swfLinkLoader(loader, bytes, info.url ?? "", domain);
  } catch (error) {
    info.dispatchEvent(
      new IOErrorEvent(IOErrorEvent.IO_ERROR, false, false, String((error as any)?.message ?? error)),
    );
    return;
  }
  hostSetTimeout(() => {
    info.dispatchEvent(new Event(Event.INIT));
    info.dispatchEvent(new Event(Event.COMPLETE));
  }, 0);
}

/** Materializes an `[Embed]` class after its generated constructor has run. */
function $applyEmbeddedAsset(target: any, C: any): void {
  const source = embeddedMetadataArgument(C, "source");
  if (typeof source !== "string" || source.length === 0) return;
  const bytes = embeddedAssetManager?.get(source) ?? null;
  if (!bytes) {
    throw new AS3RuntimeError(
      "Embed",
      `Embedded asset '${source}' for ${C.$fqcn} was not found; load its .pop and call $setAssetManager first`,
    );
  }
  const assetBase = embeddedBaseFqcn(C);
  if (assetBase === "mx.core.FontAsset") {
    registerEmbeddedFontFace(C, bytes);
    target.__embeddedBytes = bytes;
    return;
  }
  if (assetBase === "mx.core.ByteArrayAsset") {
    const capacity = Math.max(16, bytes.length);
    const storage = new Uint8Array(capacity);
    storage.set(bytes);
    byteArrayStates.set(target, {
      bytes: storage,
      view: new DataView(storage.buffer),
      length: bytes.length,
      position: 0,
      little: false,
      objectEncoding: 3,
    });
    return;
  }
  if (assetBase === "mx.core.BitmapAsset") {
    const size = pngDimensions(bytes);
    const bitmapData = runtimeNew("flash.display.BitmapData", size.width, size.height, true);
    target.bitmapData = bitmapData;
    // Flash decodes embeds synchronously. The window manager copies skin pixels as soon
    // as the class is constructed, so an async decode would cache blank skins forever.
    const decoded = decodePng(bytes);
    if (decoded) {
      setBitmapDataPixels(target, bitmapData, decoded.width, decoded.height, decoded.pixels);
    } else {
      decodeEmbeddedBitmap(target, bitmapData, bytes);
    }
    return;
  }
  target.__embeddedBytes = bytes;
}

/* ------------------------------------------------------------------ *
 * External variables and LoaderInfo.parameters
 * ------------------------------------------------------------------ */

const externalVariables: Record<string, string> = {};
let externalVariablesLoaded = false;
let externalUrl = "";
/** Flash's SWF embed `base` parameter: relative requests resolve against it. */
let externalBaseUrl = "";
let rootLoaderInfo: any = null;
let pendingRootClass: any = null;
let pendingRootStage: any = null;

function ensureExternalVariables(): void {
  if (externalVariablesLoaded) return;
  externalVariablesLoaded = true;
  const locationObject = (globalThis as any).location;
  externalUrl = typeof locationObject?.href === "string" ? locationObject.href : "";
  const search = typeof locationObject?.search === "string" ? locationObject.search : "";
  if (!search) return;
  for (const [key, value] of new URLSearchParams(search)) externalVariables[key] = value;
}

/** Host hook mirroring FlashVars/query-string initialization; values are stored as strings. */
export function $setExternalVariables(
  values: Record<string, any>,
  options: { url?: string; loaderURL?: string; base?: string } = {},
): void {
  ensureExternalVariables();
  for (const [key, value] of Object.entries(values)) {
    externalVariables[key] = value === null || value === undefined ? "" : String(value);
  }
  if (options.url !== undefined) externalUrl = String(options.url);
  if (options.loaderURL !== undefined) externalUrl = String(options.loaderURL);
  if (options.base !== undefined) externalBaseUrl = String(options.base);
  if (rootLoaderInfo) {
    rootLoaderInfo.url = externalUrl;
    rootLoaderInfo.loaderURL = externalUrl;
  }
}

/**
 * Host hook mirroring Flash's SWF embed `base` parameter. Relative `Loader` and
 * `URLLoader` requests resolve against it instead of the HTML document URL.
 */
export function $setBaseUrl(url: string): void {
  externalBaseUrl = String(url ?? "");
}

export function $getBaseUrl(): string {
  return externalBaseUrl;
}

export function $getExternalVariables(): Record<string, string> {
  ensureExternalVariables();
  return { ...externalVariables };
}

/**
 * Reports host loading progress through a LoaderInfo object. A compiled preloader can
 * listen for the same `progress`/`complete` events it would receive from Flash's loader.
 */
export function $setLoaderProgress(
  loaderInfo: any,
  bytesLoaded: number,
  bytesTotal: number,
  complete = false,
): void {
  if (!loaderInfo || typeof loaderInfo !== "object") {
    throw new AS3RuntimeError("$setLoaderProgress", "A LoaderInfo object is required");
  }
  const total = Math.max(0, Number(bytesTotal) || 0);
  const loaded = Math.max(0, Math.min(total || Number.MAX_SAFE_INTEGER, Number(bytesLoaded) || 0));
  loaderInfo.bytesLoaded = loaded;
  loaderInfo.bytesTotal = total;
  if (typeof loaderInfo.dispatchEvent === "function") {
    const ProgressEvent = $runtimeClass("flash.events.ProgressEvent");
    loaderInfo.dispatchEvent(new ProgressEvent(ProgressEvent.PROGRESS, false, false, loaded, total));
    if (complete) {
      const Event = $runtimeClass("flash.events.Event");
      loaderInfo.dispatchEvent(new Event(Event.COMPLETE));
    }
  }
}

/**
 * Constructs a display-list entry with a live stage already attached. Flash assigns the
 * root object's stage/root before its constructor body runs; this host hook reproduces
 * that ordering for a generated entry class.
 */
export function $createRoot(C: any, args: any[] = [], stage?: any): any {
  const rootStage = stage ?? runtimeNew("flash.display.Stage");
  if (!rootStage.stage) {
    rootStage.stage = rootStage;
    rootStage.root = rootStage;
  }
  const previousClass = pendingRootClass;
  const previousStage = pendingRootStage;
  pendingRootClass = C;
  pendingRootStage = rootStage;
  try {
    const root = $construct(C, args);
    if (root && root.parent !== rootStage && typeof rootStage.addChild === "function") {
      rootStage.addChild(root);
    }
    if (root && rootStage.root !== root) {
      rootStage.root = root;
      updateDisplaySubtree(rootStage, rootStage, root);
    }
    return root;
  } finally {
    pendingRootClass = previousClass;
    pendingRootStage = previousStage;
  }
}

const frameCounts = new WeakMap<object, number>();
const frameLoops = new WeakMap<object, FrameLoopHandle>();

export interface FrameLoopOptions {
  frameRate?: number;
}

export interface FrameLoopHandle {
  readonly stage: any;
  stop(): void;
}

function displayChildren(target: any): any[] {
  return Array.isArray(target?.__children) ? target.__children : [];
}

function updateDisplaySubtree(target: any, stage: any, root: any): void {
  target.stage = stage;
  if (target !== stage) target.root = root;
  for (const child of displayChildren(target)) updateDisplaySubtree(child, stage, root);
}

function dispatchDisplaySubtree(target: any, type: string): void {
  const Event = $runtimeClass("flash.events.Event");
  target.dispatchEvent(new Event(type));
  for (const child of [...displayChildren(target)]) {
    if (child.parent === target) dispatchDisplaySubtree(child, type);
  }
}

function displayRootFor(container: any, child: any): any {
  if (container.stage === container) {
    return container.root && container.root !== container ? container.root : child;
  }
  return container.root ?? child;
}

const boundMethodCache = new WeakMap<object, Map<string, any>>();

/**
 * AS3 private methods are not virtual. Resolve a method reference against the class that
 * declares it, so a subclass method with the same name cannot capture a base class reference.
 */
function declaringMethod(owner: string, property: string): any {
  const Class = registry.get(owner);
  for (let proto = Class?.prototype; proto; proto = Object.getPrototypeOf(proto)) {
    const descriptor = Object.getOwnPropertyDescriptor(proto, property);
    if (!descriptor) continue;
    return typeof descriptor.value === "function" ? descriptor.value : undefined;
  }
  return undefined;
}

/**
 * Stable AS3 method closure: repeated reads return the same function for removeEventListener.
 * `owner` names the declaring class for a private method reference.
 */
export function $bindMethod(object: any, property: string, owner?: string): any {
  if (object === null || object === undefined) return undefined;
  const value = owner ? (declaringMethod(owner, property) ?? object[property]) : object[property];
  if (typeof value !== "function") return value;
  if (typeof object !== "object" && typeof object !== "function") return value.bind(object);
  const key = owner ? `${owner}::${property}` : property;
  let cache = boundMethodCache.get(object);
  if (!cache) boundMethodCache.set(object, (cache = new Map()));
  const existing = cache.get(key);
  if (existing) return existing;
  const bound = value.bind(object);
  cache.set(key, bound);
  return bound;
}

function movieFrame(target: any, value: number): number {
  const total = Math.max(1, Math.floor(Number(target.totalFrames) || 1));
  const frame = Math.floor(Number(value));
  if (!Number.isFinite(frame)) return 1;
  return Math.min(total, Math.max(1, frame));
}

function resolveStage(value: any): any {
  const stage = value?.stage === value ? value : value?.stage;
  if (!stage || stage.stage !== stage) throw new AS3RuntimeError("Stage", "A live Stage is required");
  return stage;
}

/**
 * Host hook: the player reports its viewport. The stage does not store that size directly - it
 * derives its own size from it per `scaleMode`, exactly like Ruffle's `Stage::build_matrices`.
 */
export function $setStageSize(stageOrRoot: any, width: number, height: number): void {
  const stage = resolveStage(stageOrRoot);
  stage.__viewportWidth = Math.max(0, Number(width) || 0);
  stage.__viewportHeight = Math.max(0, Number(height) || 0);
  if (stage.__movieWidth === undefined) {
    // A project that declares no authored size has no SWF header to read one from, so the first
    // viewport doubles as the movie size.
    stage.__movieWidth = stage.__viewportWidth;
    stage.__movieHeight = stage.__viewportHeight;
  }
  stageBuildMatrices(stage);
}

/**
 * Host hook: the authored movie size, the equivalent of the SWF header Ruffle reads into
 * `Stage::movie_size`. Every scale mode except NO_SCALE reports this size, so a client that switches
 * to NO_SCALE after startup sees a real size change and receives the `resize` Flash would dispatch.
 */
export function $setStageMovieSize(stageOrRoot: any, width: number, height: number): void {
  const stage = resolveStage(stageOrRoot);
  stage.__movieWidth = Math.max(0, Number(width) || 0);
  stage.__movieHeight = Math.max(0, Number(height) || 0);
  stageBuildMatrices(stage);
}

/**
 * Ruffle `Stage::build_matrices`: a NO_SCALE stage is the viewport, every other scale mode
 * reports the movie size, and a NO_SCALE size change dispatches `Event.RESIZE` immediately
 * (`fire_resize_event`), because clients pin their layout to `stageWidth`/`stageHeight`.
 */
function stageBuildMatrices(stage: any): void {
  const noScale = stage.scaleMode === "noScale";
  const nextWidth = noScale ? Number(stage.__viewportWidth) || 0 : Number(stage.__movieWidth) || 0;
  const nextHeight = noScale ? Number(stage.__viewportHeight) || 0 : Number(stage.__movieHeight) || 0;
  const changed = stage.stageWidth !== nextWidth || stage.stageHeight !== nextHeight;
  stage.stageWidth = nextWidth;
  stage.stageHeight = nextHeight;
  stage.width = nextWidth;
  stage.height = nextHeight;
  if (!noScale || !changed) return;
  const Event = $runtimeClass("flash.events.Event");
  stage.dispatchEvent(new Event(Event.RESIZE));
}

/** Host hook: forwards a browser pointer event to the stage in stage coordinates. */
export function $dispatchMouseEvent(
  stageOrRoot: any,
  type: string,
  stageX: number,
  stageY: number,
  init: {
    buttonDown?: boolean;
    delta?: number;
    clickCount?: number;
    ctrlKey?: boolean;
    altKey?: boolean;
    shiftKey?: boolean;
  } = {},
): boolean {
  const stage = resolveStage(stageOrRoot);
  const MouseEvent = $runtimeClass("flash.events.MouseEvent");
  const x = Number(stageX) || 0;
  const y = Number(stageY) || 0;
  const event = new MouseEvent(
    type,
    true,
    true,
    x,
    y,
    null,
    Boolean(init.ctrlKey),
    Boolean(init.altKey),
    Boolean(init.shiftKey),
    Boolean(init.buttonDown),
    Number(init.delta ?? 0) | 0,
    Boolean(init.ctrlKey),
    Number(init.clickCount ?? 0) | 0,
  );
  event.stageX = x;
  event.stageY = y;
  stage.mouseX = x;
  stage.mouseY = y;
  return stage.dispatchEvent(event);
}

/**
 * Runs one deterministic frame: advances playing timelines, then dispatches
 * `enterFrame`, `frameConstructed` and `exitFrame` to listeners in stage order.
 */
export function $runFrame(stageOrRoot: any, now = runtimeNow()): number {
  void now;
  const stage = resolveStage(stageOrRoot);
  const nodes: any[] = [];
  const visit = (node: any): void => {
    nodes.push(node);
    for (const child of displayChildren(node)) {
      if (child.parent === node) visit(child);
    }
  };
  visit(stage);

  for (const node of nodes) {
    if (node.__playing === true && typeof node.currentFrame === "number") {
      const total = Math.max(1, Math.floor(Number(node.totalFrames) || 1));
      const current = Math.max(1, Math.floor(Number(node.currentFrame) || 1));
      node.currentFrame = current >= total ? 1 : current + 1;
    }
  }

  const Event = $runtimeClass("flash.events.Event");
  for (const type of [Event.ENTER_FRAME, Event.FRAME_CONSTRUCTED, Event.EXIT_FRAME]) {
    for (const node of nodes) {
      if (node.hasEventListener?.(type)) node.dispatchEvent(new Event(type));
    }
  }
  const count = (frameCounts.get(stage) ?? 0) + 1;
  frameCounts.set(stage, count);
  return count;
}

/** Starts the host frame loop. Browsers use `requestAnimationFrame`; Node uses an interval. */
export function $startFrameLoop(stageOrRoot: any, options: FrameLoopOptions = {}): FrameLoopHandle {
  const stage = resolveStage(stageOrRoot);
  if (options.frameRate !== undefined) {
    stage.frameRate = Math.max(0.01, Math.min(1000, Number(options.frameRate) || 24));
  }
  const existing = frameLoops.get(stage);
  if (existing) return existing;

  let stopped = false;
  let frameRequest: any = null;
  let timerRequest: any = null;
  let mode: "frame" | "timer" | null = null;
  const interval = (): number => 1000 / Math.max(0.01, Math.min(1000, Number(stage.frameRate) || 24));
  const requestFrame = (globalThis as any).requestAnimationFrame;
  const cancelFrame = (globalThis as any).cancelAnimationFrame;
  const hostDocument = (globalThis as any).document;
  let last = runtimeNow();

  const cancelFrameRequest = (): void => {
    if (frameRequest !== null && typeof cancelFrame === "function") cancelFrame(frameRequest);
    frameRequest = null;
  };
  const cancelTimer = (): void => {
    if (timerRequest !== null) hostClearInterval(timerRequest);
    timerRequest = null;
  };
  const tick = (value?: number): void => {
    if (stopped) return;
    const time = Number(value) || runtimeNow();
    if (time - last + 0.01 >= interval()) {
      last = time;
      $runFrame(stage, time);
    }
  };
  // Browsers suspend requestAnimationFrame in hidden tabs. Clients drive socket parsing
  // (including keep-alive replies) from update receivers, so a suspended frame loop silently
  // drops the connection; fall back to a timer while the document is hidden.
  const hidden = (): boolean => {
    try {
      return hostDocument?.visibilityState === "hidden";
    } catch {
      return false;
    }
  };
  const onFrame = (value: number): void => {
    frameRequest = null;
    mode = null;
    tick(value);
    schedule();
  };
  const schedule = (): void => {
    if (stopped || mode !== null) return;
    if (typeof requestFrame === "function" && !hidden()) {
      mode = "frame";
      frameRequest = requestFrame(onFrame);
      return;
    }
    mode = "timer";
    timerRequest = hostSetInterval(() => tick(), Math.max(1, Math.round(interval())));
  };
  const onVisibilityChange = (): void => {
    if (mode === "frame") cancelFrameRequest();
    else if (mode === "timer") cancelTimer();
    mode = null;
    schedule();
  };

  const loop: FrameLoopHandle = {
    stage,
    stop() {
      if (stopped) return;
      stopped = true;
      cancelFrameRequest();
      cancelTimer();
      mode = null;
      hostDocument?.removeEventListener?.("visibilitychange", onVisibilityChange);
      frameLoops.delete(stage);
    },
  };
  frameLoops.set(stage, loop);
  hostDocument?.addEventListener?.("visibilitychange", onVisibilityChange);
  schedule();
  return loop;
}

export function $stopFrameLoop(stageOrRoot: any): void {
  frameLoops.get(resolveStage(stageOrRoot))?.stop();
}

function getRootLoaderInfo(): any {
  if (!rootLoaderInfo) rootLoaderInfo = runtimeNew("flash.display.LoaderInfo");
  return rootLoaderInfo;
}

function capabilitiesNavigator(): any {
  return typeof navigator === "undefined" ? null : navigator;
}

function capabilitiesOs(): string {
  const value = capabilitiesNavigator();
  const platform = String(value?.platform ?? value?.userAgent ?? "");
  return /Mac/i.test(platform) ? "Mac OS 10.15.7" : /Win/i.test(platform) ? "Windows 10" : "Linux";
}

function capabilitiesVersion(): string {
  const os = capabilitiesOs();
  const family = os.startsWith("Mac") ? "MAC" : os.startsWith("Windows") ? "WIN" : "LNX";
  return `${family} 11,1,102,63`;
}

function capabilitiesServerString(): string {
  return `${capabilitiesVersion()},0`;
}

function capabilitiesLanguage(): string {
  return String(capabilitiesNavigator()?.language ?? "en-US");
}

function capabilitiesScreenWidth(): number {
  return Math.max(0, Math.trunc(Number((globalThis as any).screen?.width ?? 0)));
}

function capabilitiesScreenHeight(): number {
  return Math.max(0, Math.trunc(Number((globalThis as any).screen?.height ?? 0)));
}

let applicationDomainSingleton: any = null;
let securityDomainSingleton: any = null;

function currentApplicationDomain(): any {
  if (!applicationDomainSingleton) applicationDomainSingleton = runtimeNew("flash.system.ApplicationDomain");
  return applicationDomainSingleton;
}

function currentSecurityDomain(): any {
  if (!securityDomainSingleton) securityDomainSingleton = runtimeNew("flash.system.SecurityDomain");
  return securityDomainSingleton;
}

const externalCallbacks = new Map<string, any>();
let externalInterfaceBridge: any = null;

/** Installs or replaces the JS object used by `flash.external.ExternalInterface`. */
export function $setExternalInterfaceBridge(bridge: any): void {
  externalInterfaceBridge = bridge ?? null;
}

function externalInterfaceObject(): any {
  if (externalInterfaceBridge) return externalInterfaceBridge;
  const global = globalThis as any;
  return global.FlashExternalInterface ?? global.__as3jsExternalInterface ?? null;
}

function externalInterfaceAvailable(): boolean {
  const bridge = externalInterfaceObject();
  return Boolean(bridge && (typeof bridge === "object" || typeof bridge === "function"));
}

function externalInterfaceFunction(name: string): { fn: Function; owner: any } | null {
  const path = String(name).split(".").filter(Boolean);
  if (path.length === 0) return null;
  const bridge = externalInterfaceObject();
  if (path.length === 1 && bridge && typeof bridge[path[0]!] === "function") {
    return { fn: bridge[path[0]!], owner: bridge };
  }
  let owner: any = globalThis;
  for (const part of path.slice(0, -1)) {
    owner = owner?.[part];
    if (!owner) return null;
  }
  const fn = owner?.[path[path.length - 1]!];
  return typeof fn === "function" ? { fn, owner } : null;
}

const registeredEmbeddedFonts: any[] = [];
const registeredFontByClass = new Map<any, any>();

function embeddedFontName(fontClass: any): string {
  const named =
    embeddedMetadataArgument(fontClass, "fontName") ??
    embeddedMetadataArgument(fontClass, "fontFamily");
  if (typeof named === "string" && named.length > 0) return named;
  const fqcn =
    typeof fontClass?.$fqcn === "string"
      ? fontClass.$fqcn
      : typeof fontClass?.$desc?.name === "string"
        ? fontClass.$desc.name
        : "";
  const short = fqcn.slice(fqcn.lastIndexOf(".") + 1);
  return short.length > 0 ? short : "sans-serif";
}

const embeddedFontFaces = new Map<any, any>();

/** Loads an `[Embed]` font into the host so canvas text uses Flash's family and metrics. */
function registerEmbeddedFontFace(fontClass: any, bytes: Uint8Array): void {
  if (embeddedFontFaces.has(fontClass)) return;
  const FontFaceCtor = (globalThis as any).FontFace;
  const fonts = (globalThis as any).document?.fonts;
  if (typeof FontFaceCtor !== "function" || !fonts || typeof fonts.add !== "function") return;
  const family = embeddedFontName(fontClass);
  const style = embeddedFontStyle(fontClass);
  const descriptors: Record<string, string> = {};
  if (style === "bold" || style === "boldItalic") descriptors.weight = "bold";
  if (style === "italic" || style === "boldItalic") descriptors.style = "italic";
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  try {
    const face = new FontFaceCtor(family, buffer, descriptors);
    embeddedFontFaces.set(fontClass, face);
    fonts.add(face);
    const loading = face.load?.();
    if (loading && typeof loading.catch === "function") {
      loading.catch(() => embeddedFontFaces.delete(fontClass));
    }
  } catch {
    // A host that rejects the face keeps the fallback family instead of failing the embed.
    embeddedFontFaces.delete(fontClass);
  }
}

/** Resolves the bytes an `[Embed]` font class points at, if the asset bundle is available. */
function embeddedFontBytes(fontClass: any): Uint8Array | null {
  const source = embeddedMetadataArgument(fontClass, "source");
  if (typeof source !== "string" || source.length === 0) return null;
  return embeddedAssetManager?.get(source) ?? null;
}

function embeddedFontStyle(fontClass: any): string {
  const weight = String(embeddedMetadataArgument(fontClass, "fontWeight") ?? "").toLowerCase();
  const style = String(embeddedMetadataArgument(fontClass, "fontStyle") ?? "").toLowerCase();
  const bold = weight === "bold";
  const italic = style === "italic";
  return bold && italic ? "boldItalic" : bold ? "bold" : italic ? "italic" : "regular";
}

const IDENTITY_COLOR_MATRIX = [
  1, 0, 0, 0, 0,
  0, 1, 0, 0, 0,
  0, 0, 1, 0, 0,
  0, 0, 0, 1, 0,
];

interface ColorTransformValues {
  redMultiplier: number;
  greenMultiplier: number;
  blueMultiplier: number;
  alphaMultiplier: number;
  redOffset: number;
  greenOffset: number;
  blueOffset: number;
  alphaOffset: number;
}

function colorTransformValues(colorTransform: any): ColorTransformValues {
  return {
    redMultiplier: Number(colorTransform?.redMultiplier ?? 1),
    greenMultiplier: Number(colorTransform?.greenMultiplier ?? 1),
    blueMultiplier: Number(colorTransform?.blueMultiplier ?? 1),
    alphaMultiplier: Number(colorTransform?.alphaMultiplier ?? 1),
    redOffset: Number(colorTransform?.redOffset ?? 0),
    greenOffset: Number(colorTransform?.greenOffset ?? 0),
    blueOffset: Number(colorTransform?.blueOffset ?? 0),
    alphaOffset: Number(colorTransform?.alphaOffset ?? 0),
  };
}

/** Source-over composite of one straight-alpha ARGB pixel, with the colour transform applied first. */
/** Flash's channel blend functions; both inputs and the result are 0..1. */
function blendChannel(mode: string, source: number, destination: number): number {
  switch (mode) {
    case "darken": return Math.min(source, destination);
    case "lighten": return Math.max(source, destination);
    case "multiply": return source * destination;
    case "screen": return 1 - (1 - source) * (1 - destination);
    case "add": return Math.min(1, source + destination);
    case "subtract": return Math.max(0, destination - source);
    case "difference": return Math.abs(destination - source);
    case "overlay":
      return destination < 0.5
        ? 2 * source * destination
        : 1 - 2 * (1 - source) * (1 - destination);
    case "hardlight":
      return source < 0.5
        ? 2 * source * destination
        : 1 - 2 * (1 - source) * (1 - destination);
    default: return source;
  }
}

function compositePixel(
  target: BitmapDataState,
  index: number,
  pixel: number,
  colorTransform: ColorTransformValues,
  blendMode = "normal",
): void {
  const sourceAlpha = Math.min(
    1,
    Math.max(0, (((pixel >>> 24) & 0xff) / 255) * colorTransform.alphaMultiplier + colorTransform.alphaOffset / 255),
  );
  if (sourceAlpha <= 0) return;
  const destination = target.pixels[index]!;
  const destinationAlpha = ((destination >>> 24) & 0xff) / 255;
  const outAlpha = sourceAlpha + destinationAlpha * (1 - sourceAlpha);
  const tint = (value: number, multiplier: number, offset: number) =>
    Math.min(255, Math.max(0, value * multiplier + offset));
  const composite = (tinted: number, background: number) => {
    const source = tinted / 255;
    const backdrop = background / 255;
    const blended = blendChannel(blendMode, source, backdrop);
    const value = (
      blended * sourceAlpha * destinationAlpha +
      source * sourceAlpha * (1 - destinationAlpha) +
      backdrop * destinationAlpha * (1 - sourceAlpha)
    ) / outAlpha;
    return Math.min(255, Math.max(0, Math.round(value * 255)));
  };
  const red = composite(tint((pixel >>> 16) & 0xff, colorTransform.redMultiplier, colorTransform.redOffset), (destination >>> 16) & 0xff);
  const green = composite(tint((pixel >>> 8) & 0xff, colorTransform.greenMultiplier, colorTransform.greenOffset), (destination >>> 8) & 0xff);
  const blue = composite(tint(pixel & 0xff, colorTransform.blueMultiplier, colorTransform.blueOffset), destination & 0xff);
  target.pixels[index] = ((Math.round(outAlpha * 255) << 24) | (red << 16) | (green << 8) | blue) >>> 0;
}

/**
 * Renders a display tree into ARGB pixels through the host canvas. `draw()` draws the
 * object's content at the origin, so its own x/y/rotation/scale are neutralised first.
 */
function rasterizeDisplayObject(source: any, width: number, height: number, matrix: any, smoothing: boolean): Uint32Array {
  if (!source || typeof source !== "object") {
    throw new AS3RuntimeError("BitmapData.draw", "The source must be a BitmapData or a display object");
  }
  const scratch = createScratchCanvas(width, height);
  if (!scratch) {
    throw new AS3RuntimeError("BitmapData.draw", "The host has no canvas to render a display object into");
  }
  const context = scratch.context;
  if (typeof context.setTransform !== "function" || typeof context.getImageData !== "function") {
    throw new AS3RuntimeError("BitmapData.draw", "A canvas 2D context with setTransform and getImageData is required");
  }
  context.setTransform(
    Number(matrix?.a ?? 1),
    Number(matrix?.b ?? 0),
    Number(matrix?.c ?? 0),
    Number(matrix?.d ?? 1),
    Number(matrix?.tx ?? 0),
    Number(matrix?.ty ?? 0),
  );
  context.imageSmoothingEnabled = Boolean(smoothing);
  const saved = {
    x: source.x,
    y: source.y,
    rotation: source.rotation,
    scaleX: source.scaleX,
    scaleY: source.scaleY,
  };
  source.x = 0;
  source.y = 0;
  source.rotation = 0;
  source.scaleX = 1;
  source.scaleY = 1;
  try {
    $renderDisplay(source, context, 1);
  } finally {
    source.x = saved.x;
    source.y = saved.y;
    source.rotation = saved.rotation;
    source.scaleX = saved.scaleX;
    source.scaleY = saved.scaleY;
  }
  const rgba = context.getImageData(0, 0, width, height).data;
  const pixels = new Uint32Array(width * height);
  for (let index = 0; index < pixels.length; index += 1) {
    pixels[index] =
      ((rgba[index * 4 + 3]! << 24) | (rgba[index * 4]! << 16) | (rgba[index * 4 + 1]! << 8) | rgba[index * 4 + 2]!) >>> 0;
  }
  return pixels;
}

function bitmapPixelAt(state: BitmapDataState, x: number, y: number): number {
  if (x < 0 || y < 0 || x >= state.width || y >= state.height) return 0;
  return state.pixels[y * state.width + x]!;
}

/**
 * Flash's `Array` extras: the sort flag constants, `sortOn` and a numeric `sort`. Arrays
 * are native JavaScript arrays here, so the intrinsics live on `Array` itself.
 */
function installArrayIntrinsics(): void {
  const arrayClass = Array as any;
  for (const [name, value] of [
    ["CASEINSENSITIVE", 1],
    ["DESCENDING", 2],
    ["UNIQUESORT", 4],
    ["RETURNINDEXEDARRAY", 8],
    ["NUMERIC", 16],
  ] as Array<[string, number]>) {
    if (arrayClass[name] === undefined) arrayClass[name] = value;
  }
  const prototype = Array.prototype as any;
  if (typeof prototype.sortOn !== "function") {
    Object.defineProperty(prototype, "sortOn", {
      configurable: true,
      writable: true,
      value: function(this: any[], fieldName: any, options: any) {
        return flashSortOn(this, fieldName, options);
      },
    });
  }
}

const nativeArraySort = Array.prototype.sort;

/** Flash's `sort`: a number argument is the sort flags, not a comparator. */
function flashSort(this: any[], compareFunction?: any): any[] {
  if (typeof compareFunction === "function" || compareFunction === undefined) {
    return nativeArraySort.call(this, compareFunction);
  }
  const options = Number(compareFunction) || 0;
  const numeric = (options & 16) !== 0;
  const descending = (options & 2) !== 0;
  const unique = (options & 4) !== 0;
  const indexed = (options & 8) !== 0;
  const pairs = this.map((value, index) => ({ value, index }));
  let duplicate = false;
  pairs.sort((left, right) => {
    const a = numeric ? Number(left.value ?? 0) : String(left.value ?? "");
    const b = numeric ? Number(right.value ?? 0) : String(right.value ?? "");
    let result = 0;
    if (a === b) {
      duplicate = true;
      result = 0;
    } else {
      result = a < b ? -1 : 1;
    }
    return descending ? -result : result;
  });
  if (unique && duplicate) return this;
  if (indexed) return pairs.map((pair) => pair.index);
  for (let index = 0; index < pairs.length; index += 1) this[index] = pairs[index]!.value;
  return this;
}

/** Flash's `sortOn`: sort by one or more field names, each with its own sort flags. */
function flashSortOn(array: any[], fieldName: any, options: any): any {
  const optionBits = typeof options === "number" ? options : 0;
  // Flash pairs a field-name array with an options array positionally.
  const optionList: any[] | null = Array.isArray(options) ? options : null;
  const fields: Array<{ name: string; options: number }> = [];
  if (typeof fieldName === "string") {
    fields.push({ name: fieldName, options: Number(optionList?.[0] ?? optionBits) || 0 });
  } else if (Array.isArray(fieldName)) {
    fieldName.forEach((entry: any, index: number) => {
      const entryOptions = Number(optionList?.[index] ?? optionBits) || 0;
      if (typeof entry === "string") {
        fields.push({ name: entry, options: entryOptions });
      } else if (entry && typeof entry === "object") {
        fields.push({ name: String(entry.name ?? ""), options: Number(entry.options ?? entryOptions) || 0 });
      }
    });
  }
  if (fields.length === 0) return array;
  const indexed = fields.some((field) => (field.options & 8) !== 0);
  const unique = fields.some((field) => (field.options & 4) !== 0);
  const pairs = array.map((value, index) => ({ value, index }));
  let duplicate = false;
  pairs.sort((left, right) => {
    for (const field of fields) {
      let a = left.value?.[field.name];
      let b = right.value?.[field.name];
      if (field.options & 16) {
        a = Number(a ?? 0);
        b = Number(b ?? 0);
      } else if ((field.options & 1) !== 0 && typeof a === "string" && typeof b === "string") {
        a = a.toLowerCase();
        b = b.toLowerCase();
      }
      let result = 0;
      if (a === b) {
        result = 0;
      } else if (a === undefined || a === null) {
        result = -1;
      } else if (b === undefined || b === null) {
        result = 1;
      } else {
        result = a < b ? -1 : 1;
      }
      if (field.options & 2) result = -result;
      if (result !== 0) return result;
    }
    duplicate = true;
    return 0;
  });
  if (unique && duplicate) return array;
  if (indexed) return pairs.map((pair) => pair.index);
  for (let index = 0; index < pairs.length; index += 1) array[index] = pairs[index]!.value;
  return array;
}

function colorMatrixPixels(pixels: Uint32Array, matrix: number[]): Uint32Array {
  const out = new Uint32Array(pixels.length);
  const clamp = (value: number) => (value < 0 ? 0 : value > 255 ? 255 : Math.round(value));
  for (let index = 0; index < pixels.length; index += 1) {
    const pixel = pixels[index]!;
    const a = (pixel >>> 24) & 0xff;
    const r = (pixel >>> 16) & 0xff;
    const g = (pixel >>> 8) & 0xff;
    const b = pixel & 0xff;
    const red = clamp(matrix[0]! * r + matrix[1]! * g + matrix[2]! * b + matrix[3]! * a + matrix[4]!);
    const green = clamp(matrix[5]! * r + matrix[6]! * g + matrix[7]! * b + matrix[8]! * a + matrix[9]!);
    const blue = clamp(matrix[10]! * r + matrix[11]! * g + matrix[12]! * b + matrix[13]! * a + matrix[14]!);
    const alpha = clamp(matrix[15]! * r + matrix[16]! * g + matrix[17]! * b + matrix[18]! * a + matrix[19]!);
    out[index] = ((alpha << 24) | (red << 16) | (green << 8) | blue) >>> 0;
  }
  return out;
}

/** Straight ARGB pixels → premultiplied RGBA floats (0-255). */
function premultipliedRgba(pixels: Uint32Array): Float32Array {
  const out = new Float32Array(pixels.length * 4);
  for (let index = 0; index < pixels.length; index += 1) {
    const pixel = pixels[index]!;
    const alpha = ((pixel >>> 24) & 0xff) / 255;
    out[index * 4] = ((pixel >>> 16) & 0xff) * alpha;
    out[index * 4 + 1] = ((pixel >>> 8) & 0xff) * alpha;
    out[index * 4 + 2] = (pixel & 0xff) * alpha;
    out[index * 4 + 3] = (pixel >>> 24) & 0xff;
  }
  return out;
}

/** Premultiplied RGBA floats → straight ARGB pixels. */
function straightPixels(data: Float32Array, width: number, height: number): Uint32Array {
  const out = new Uint32Array(width * height);
  for (let index = 0; index < out.length; index += 1) {
    const alpha = Math.min(255, Math.max(0, Math.round(data[index * 4 + 3]!)));
    let red = 0;
    let green = 0;
    let blue = 0;
    if (alpha > 0) {
      const scale = 255 / alpha;
      red = Math.min(255, Math.max(0, Math.round(data[index * 4]! * scale)));
      green = Math.min(255, Math.max(0, Math.round(data[index * 4 + 1]! * scale)));
      blue = Math.min(255, Math.max(0, Math.round(data[index * 4 + 2]! * scale)));
    }
    out[index] = ((alpha << 24) | (red << 16) | (green << 8) | blue) >>> 0;
  }
  return out;
}

/** `passes` box blurs of `sizeX` × `sizeY` pixels, which approaches Flash's Gaussian blur. */
function boxBlurRgba(data: Float32Array, width: number, height: number, sizeX: number, sizeY: number, passes: number): void {
  const temp = new Float32Array(data.length);
  for (let pass = 0; pass < passes; pass += 1) {
    if (sizeX > 1) {
      blurRgbaAxis(data, temp, width, height, Math.round(sizeX), true);
      data.set(temp);
    }
    if (sizeY > 1) {
      blurRgbaAxis(data, temp, width, height, Math.round(sizeY), false);
      data.set(temp);
    }
  }
}

function blurRgbaAxis(
  source: Float32Array,
  destination: Float32Array,
  width: number,
  height: number,
  size: number,
  horizontal: boolean,
): void {
  const half = Math.floor(size / 2);
  const lines = horizontal ? height : width;
  const length = horizontal ? width : height;
  const offset = (line: number, index: number) => (horizontal ? line * width + index : index * width + line) * 4;
  for (let line = 0; line < lines; line += 1) {
    for (let channel = 0; channel < 4; channel += 1) {
      let sum = 0;
      for (let index = -half; index < size - half; index += 1) {
        if (index >= 0 && index < length) sum += source[offset(line, index) + channel]!;
      }
      for (let index = 0; index < length; index += 1) {
        destination[offset(line, index) + channel] = sum / size;
        const leaving = index - half;
        const entering = index + size - half;
        if (leaving >= 0 && leaving < length) sum -= source[offset(line, leaving) + channel]!;
        if (entering >= 0 && entering < length) sum += source[offset(line, entering) + channel]!;
      }
    }
  }
}

function blurPixels(pixels: Uint32Array, width: number, height: number, filter: any): Uint32Array {
  const data = premultipliedRgba(pixels);
  boxBlurRgba(
    data,
    width,
    height,
    Number(filter?.blurX ?? 4),
    Number(filter?.blurY ?? 4),
    Math.max(1, Math.floor(Number(filter?.quality ?? 1))),
  );
  return straightPixels(data, width, height);
}

/** A glow or drop shadow: the source alpha offset and blurred, drawn in `color` behind (or inside) the source. */
function shadowPixels(
  pixels: Uint32Array,
  width: number,
  height: number,
  filter: any,
  dx: number,
  dy: number,
): Uint32Array {
  const inner = Boolean(filter?.inner);
  const knockout = Boolean(filter?.knockout);
  const hideObject = Boolean(filter?.hideObject);
  const mask = new Float32Array(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const sourceX = x - Math.round(dx);
      const sourceY = y - Math.round(dy);
      const alpha =
        sourceX >= 0 && sourceY >= 0 && sourceX < width && sourceY < height
          ? (pixels[sourceY * width + sourceX]! >>> 24) & 0xff
          : 0;
      mask[(y * width + x) * 4 + 3] = inner ? 255 - alpha : alpha;
    }
  }
  boxBlurRgba(
    mask,
    width,
    height,
    Number(filter?.blurX ?? 4),
    Number(filter?.blurY ?? 4),
    Math.max(1, Math.floor(Number(filter?.quality ?? 1))),
  );
  const color = Number(filter?.color ?? 0) >>> 0;
  const strength = Number(filter?.strength ?? 1);
  const opacity = Number(filter?.alpha ?? 1);
  const showSource = !knockout && !hideObject;
  const colorRed = (color >>> 16) & 0xff;
  const colorGreen = (color >>> 8) & 0xff;
  const colorBlue = color & 0xff;
  const out = new Uint32Array(width * height);
  for (let index = 0; index < out.length; index += 1) {
    const pixel = pixels[index]!;
    const sourceAlpha = ((pixel >>> 24) & 0xff) / 255;
    let glowAlpha = Math.min(1, (mask[index * 4 + 3]! / 255) * strength) * opacity;
    if (inner) glowAlpha *= sourceAlpha;
    let red = 0;
    let green = 0;
    let blue = 0;
    let alpha = 0;
    if (inner) {
      if (showSource) {
        alpha = sourceAlpha;
        const mix = sourceAlpha > 0 ? glowAlpha / sourceAlpha : 0;
        red = ((pixel >>> 16) & 0xff) * (1 - mix) + colorRed * mix;
        green = ((pixel >>> 8) & 0xff) * (1 - mix) + colorGreen * mix;
        blue = (pixel & 0xff) * (1 - mix) + colorBlue * mix;
      } else {
        alpha = glowAlpha;
        red = colorRed;
        green = colorGreen;
        blue = colorBlue;
      }
    } else {
      const behind = knockout ? glowAlpha * (1 - sourceAlpha) : glowAlpha;
      if (showSource) {
        alpha = sourceAlpha + behind * (1 - sourceAlpha);
        if (alpha > 0) {
          red = (((pixel >>> 16) & 0xff) * sourceAlpha + colorRed * behind * (1 - sourceAlpha)) / alpha;
          green = (((pixel >>> 8) & 0xff) * sourceAlpha + colorGreen * behind * (1 - sourceAlpha)) / alpha;
          blue = ((pixel & 0xff) * sourceAlpha + colorBlue * behind * (1 - sourceAlpha)) / alpha;
        }
      } else {
        alpha = behind;
        red = colorRed;
        green = colorGreen;
        blue = colorBlue;
      }
    }
    out[index] =
      ((Math.min(255, Math.max(0, Math.round(alpha * 255))) << 24) |
        (Math.min(255, Math.max(0, Math.round(red))) << 16) |
        (Math.min(255, Math.max(0, Math.round(green))) << 8) |
        Math.min(255, Math.max(0, Math.round(blue)))) >>> 0;
  }
  return out;
}

function convolutionPixels(pixels: Uint32Array, width: number, height: number, filter: any): Uint32Array {
  const matrix: number[] = Array.isArray(filter?.matrix) ? filter.matrix.map(Number) : [];
  if (matrix.length === 0) {
    throw new AS3RuntimeError("BitmapData.applyFilter", "ConvolutionFilter needs a matrix");
  }
  const matrixX = Math.max(1, Math.floor(Number(filter?.matrixX ?? 0)) || Math.floor(Math.sqrt(matrix.length)) || 1);
  const matrixY = Math.max(1, Math.floor(Number(filter?.matrixY ?? 0)) || Math.ceil(matrix.length / matrixX));
  const divisorValue = Number(filter?.divisor ?? 1);
  const divisor = divisorValue === 0 ? 1 : divisorValue;
  const bias = Number(filter?.bias ?? 0);
  const preserveAlpha = filter?.preserveAlpha === undefined ? true : Boolean(filter.preserveAlpha);
  const clamped = filter?.clamp === undefined ? true : Boolean(filter.clamp);
  const color = Number(filter?.color ?? 0) >>> 0;
  const alpha = Math.round(Math.min(1, Math.max(0, Number(filter?.alpha ?? 0))) * 255);
  const finish = (value: number) => {
    if (clamped) return Math.min(255, Math.max(0, Math.round(value)));
    return ((Math.round(value) % 256) + 256) % 256;
  };
  const halfX = Math.floor(matrixX / 2);
  const halfY = Math.floor(matrixY / 2);
  const out = new Uint32Array(width * height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      let red = 0;
      let green = 0;
      let blue = 0;
      let sampledAlpha = 0;
      for (let row = 0; row < matrixY; row += 1) {
        for (let column = 0; column < matrixX; column += 1) {
          const weight = matrix[row * matrixX + column];
          if (!weight) continue;
          const sourceX = x + column - halfX;
          const sourceY = y + row - halfY;
          let sample: number;
          if (sourceX >= 0 && sourceY >= 0 && sourceX < width && sourceY < height) {
            sample = pixels[sourceY * width + sourceX]!;
          } else if (clamped) {
            const clampedX = Math.min(width - 1, Math.max(0, sourceX));
            const clampedY = Math.min(height - 1, Math.max(0, sourceY));
            sample = pixels[clampedY * width + clampedX]!;
          } else {
            sample = ((alpha << 24) | (color & 0xffffff)) >>> 0;
          }
          red += ((sample >>> 16) & 0xff) * weight;
          green += ((sample >>> 8) & 0xff) * weight;
          blue += (sample & 0xff) * weight;
          sampledAlpha += ((sample >>> 24) & 0xff) * weight;
        }
      }
      const source = pixels[y * width + x]!;
      const outAlpha = preserveAlpha ? (source >>> 24) & 0xff : finish(sampledAlpha / divisor + bias);
      out[y * width + x] =
        ((outAlpha << 24) |
          (finish(red / divisor + bias) << 16) |
          (finish(green / divisor + bias) << 8) |
          finish(blue / divisor + bias)) >>> 0;
    }
  }
  return out;
}

function displacementPixels(pixels: Uint32Array, width: number, height: number, filter: any): Uint32Array {
  const map = filter?.mapBitmap ? bitmapDataStates.get(filter.mapBitmap) : null;
  if (!map) return pixels.slice();
  const channelIndex = (component: number) =>
    component === 1 ? 0 : component === 2 ? 1 : component === 4 ? 2 : component === 8 ? 3 : -1;
  const componentX = channelIndex(Number(filter?.componentX ?? 0));
  const componentY = channelIndex(Number(filter?.componentY ?? 0));
  const scaleX = Number(filter?.scaleX ?? 0);
  const scaleY = Number(filter?.scaleY ?? 0);
  const mode = String(filter?.mode ?? "wrap");
  const mapPoint = filter?.mapPoint ?? { x: 0, y: 0 };
  const mapX = Number(mapPoint.x ?? 0);
  const mapY = Number(mapPoint.y ?? 0);
  const fill = Number(filter?.color ?? 0) >>> 0;
  const fillAlpha = Math.round(Math.min(1, Math.max(0, Number(filter?.alpha ?? 0))) * 255);
  const out = new Uint32Array(width * height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const mapPixel = bitmapPixelAt(map, x - mapX, y - mapY);
      const channel = (index: number) =>
        index < 0 ? 128 : index === 3 ? (mapPixel >>> 24) & 0xff : (mapPixel >>> (16 - index * 8)) & 0xff;
      let sourceX = Math.round(x + ((channel(componentX) - 128) * scaleX) / 256);
      let sourceY = Math.round(y + ((channel(componentY) - 128) * scaleY) / 256);
      const index = y * width + x;
      if (sourceX < 0 || sourceY < 0 || sourceX >= width || sourceY >= height) {
        if (mode === "wrap") {
          sourceX = ((sourceX % width) + width) % width;
          sourceY = ((sourceY % height) + height) % height;
        } else if (mode === "clamp") {
          sourceX = Math.min(width - 1, Math.max(0, sourceX));
          sourceY = Math.min(height - 1, Math.max(0, sourceY));
        } else if (mode === "ignore") {
          sourceX = x;
          sourceY = y;
        } else {
          out[index] = ((fillAlpha << 24) | (fill & 0xffffff)) >>> 0;
          continue;
        }
      }
      out[index] = pixels[sourceY * width + sourceX]!;
    }
  }
  return out;
}

const EXTERNAL_DEFINITIONS: Record<string, ExternalDefinition> = {
  "flash.errors.IllegalOperationError": {
    init(target) {
      target.name = "IllegalOperationError";
    },
  },
  "flash.filters.ColorMatrixFilter": {
    fields: { matrix: { type: "Array" } },
    init(target) {
      target.matrix = [...IDENTITY_COLOR_MATRIX];
    },
    methods: {
      clone: function(this: any) {
        const copy = runtimeNew("flash.filters.ColorMatrixFilter");
        copy.matrix = [...this.matrix];
        return copy;
      },
    },
  },
  "flash.text.Font": {
    fields: {
      fontName: { type: "String" },
      fontType: { type: "String" },
      fontStyle: { type: "String" },
    },
    statics: {
      /** Registers an `[Embed]` font class, as Flash does for `Font.registerFont`. */
      registerFont: function(fontClass: any): any {
        if (!fontClass || typeof fontClass !== "function") {
          throw new AS3RuntimeError("flash.text.Font.registerFont", "A font class is required");
        }
        const existing = registeredFontByClass.get(fontClass);
        if (existing) return existing;
        const font = runtimeNew("flash.text.Font");
        font.fontName = embeddedFontName(fontClass);
        font.fontType = "embedded";
        font.fontStyle = embeddedFontStyle(fontClass);
        Object.defineProperty(font, "$fqcn", {
          value: typeof fontClass.$fqcn === "string" ? fontClass.$fqcn : "",
          writable: true,
          configurable: true,
        });
        registeredFontByClass.set(fontClass, font);
        registeredEmbeddedFonts.push(font);
        // Flash makes the embedded face available to text fields at registration time.
        const fontBytes = embeddedFontBytes(fontClass);
        if (fontBytes) registerEmbeddedFontFace(fontClass, fontBytes);
        return font;
      },
      /** `embedded === false` lists embedded fonts; device fonts are not modeled. */
      enumerateFonts: function(embedded?: any): any[] {
        return embedded === false ? [...registeredEmbeddedFonts] : [];
      },
    },
    init(target: any, args: any[]) {
      const source = args[0];
      if (!source || typeof source !== "object") return;
      if (typeof source.fontName === "string") target.fontName = source.fontName;
      if (typeof source.fontType === "string") target.fontType = source.fontType;
      if (typeof source.fontStyle === "string") target.fontStyle = source.fontStyle;
      if (typeof source.$fqcn === "string") {
        Object.defineProperty(target, "$fqcn", {
          value: source.$fqcn,
          writable: true,
          configurable: true,
        });
      }
    },
  },
  "flash.events.Event": {
    fields: {
      type: { type: "String" },
      bubbles: { type: "Boolean" },
      cancelable: { type: "Boolean" },
      target: { type: "Object" },
      currentTarget: { type: "Object" },
      eventPhase: { type: "uint" },
    },
    staticValues: {
      ACTIVATE: "activate",
      ADDED: "added",
      ADDED_TO_STAGE: "addedToStage",
      CANCEL: "cancel",
      CHANGE: "change",
      CLEAR: "clear",
      CLOSE: "close",
      CLOSING: "closing",
      COMPLETE: "complete",
      CONNECT: "connect",
      COPY: "copy",
      CUT: "cut",
      DEACTIVATE: "deactivate",
      DISPLAYING: "displaying",
      ENTER_FRAME: "enterFrame",
      EXIT_FRAME: "exitFrame",
      EXITING: "exiting",
      FRAME_CONSTRUCTED: "frameConstructed",
      FULLSCREEN: "fullScreen",
      INIT: "init",
      MOUSE_LEAVE: "mouseLeave",
      NETWORK_CHANGE: "networkChange",
      OPEN: "open",
      PASTE: "paste",
      REMOVED: "removed",
      REMOVED_FROM_STAGE: "removedFromStage",
      RENDER: "render",
      RESIZE: "resize",
      SCROLL: "scroll",
      SELECT: "select",
      SELECT_ALL: "selectAll",
      SOUND_COMPLETE: "soundComplete",
      TAB_CHILDREN_CHANGE: "tabChildrenChange",
      TAB_ENABLED_CHANGE: "tabEnabledChange",
      TAB_INDEX_CHANGE: "tabIndexChange",
      UNLOAD: "unload",
      USER_IDLE: "userIdle",
      USER_PRESENT: "userPresent",
    },
    methods: {
      clone: function(this: any) {
        return new this.constructor(this.type, this.bubbles, this.cancelable);
      },
      preventDefault: function(this: any) {
        if (this.cancelable) this.__defaultPrevented = true;
      },
      isDefaultPrevented: function(this: any) {
        return Boolean(this.__defaultPrevented);
      },
      stopPropagation: function(this: any) {
        if (this.__stop < 1) this.__stop = 1;
      },
      stopImmediatePropagation: function(this: any) {
        this.__stop = 2;
      },
      formatToString: function(this: any, className: string, ...names: string[]) {
        const parts = names.map((name) => {
          const value = this[name];
          return `${name}=${typeof value === "string" ? `"${value}"` : String(value)}`;
        });
        return `[${[className, ...parts].join(" ")}]`;
      },
      toString: function(this: any) {
        return this.formatToString("Event", "type", "bubbles", "cancelable", "eventPhase");
      },
    },
    init(target, args) {
      target.type = String(args[0] ?? "");
      target.bubbles = Boolean(args[1] ?? false);
      target.cancelable = Boolean(args[2] ?? false);
      target.target = null;
      target.currentTarget = null;
      target.eventPhase = 0;
      target.__defaultPrevented = false;
      target.__stop = 0;
    },
  },
  "flash.events.EventDispatcher": {
    methods: {
      addEventListener: function(this: any, type: string, listener: any, useCapture = false, priority = 0) {
        if (typeof listener !== "function") {
          throw new AS3RuntimeError("EventDispatcher.addEventListener", "Listener must be a function");
        }
        const table = useCapture ? this.__capture : this.__bubble;
        let list = table.get(type);
        if (!list) table.set(type, (list = []));
        if (list.some((entry: any) => entry.listener === listener)) return;
        let at = list.length;
        while (at > 0 && list[at - 1].priority < priority) at--;
        list.splice(at, 0, { listener, priority });
      },
      removeEventListener: function(this: any, type: string, listener: any, useCapture = false) {
        const table = useCapture ? this.__capture : this.__bubble;
        const list = table.get(type);
        if (!list) return;
        const index = list.findIndex((entry: any) => entry.listener === listener);
        if (index >= 0) list.splice(index, 1);
        if (list.length === 0) table.delete(type);
      },
      dispatchEvent: function(this: any, event: any) {
        if (!event) throw new AS3RuntimeError("EventDispatcher.dispatchEvent", "Event is required");
        if (event.target != null) event = event.clone();
        const ancestors: any[] = [];
        const seen = new Set<any>();
        for (let parent = this.parent; parent && !seen.has(parent); parent = parent.parent) {
          seen.add(parent);
          ancestors.push(parent);
        }
        const invoke = (target: any, capture: boolean, phase: number): void => {
          const list = (capture ? target.__capture : target.__bubble)?.get(event.type);
          if (!list) return;
          event.currentTarget = target;
          event.eventPhase = phase;
          for (const entry of [...list]) {
            entry.listener.call(target, event);
            if (event.__stop === 2) return;
          }
        };
        // `new EventDispatcher(target)` makes the supplied object the event target; aggregated
        // dispatchers (EventDispatcherWrapper) rely on this to report themselves, not the
        // internal dispatcher, to listeners that cast `event.target`.
        event.target = this.__dispatchTarget ?? this;
        event.currentTarget = null;
        event.eventPhase = 0;
        event.__stop = 0;
        try {
          for (let index = ancestors.length - 1; index >= 0; index -= 1) {
            invoke(ancestors[index], true, 1);
            if (event.__stop) return !event.isDefaultPrevented();
          }
          invoke(this, false, 2);
          if (event.__stop || !event.bubbles) return !event.isDefaultPrevented();
          for (const ancestor of ancestors) {
            invoke(ancestor, false, 3);
            if (event.__stop) break;
          }
          return !event.isDefaultPrevented();
        } finally {
          event.currentTarget = null;
          event.eventPhase = 0;
        }
      },
      hasEventListener: function(this: any, type: string) {
        return (this.__bubble.get(type)?.length ?? 0) > 0 || (this.__capture.get(type)?.length ?? 0) > 0;
      },
      willTrigger: function(this: any, type: string) {
        if (this.hasEventListener(type)) return true;
        for (let parent = this.parent; parent; parent = parent.parent) {
          if (parent.hasEventListener?.(type)) return true;
        }
        return false;
      },
    },
    init(target, args) {
      Object.defineProperties(target, {
        __bubble: { value: new Map<string, any[]>(), writable: true, enumerable: false, configurable: true },
        __capture: { value: new Map<string, any[]>(), writable: true, enumerable: false, configurable: true },
        // The optional constructor argument is the target reported for aggregated dispatchers.
        __dispatchTarget: { value: args?.[0] ?? null, writable: true, enumerable: false, configurable: true },
      });
    },
  },
  "flash.utils.ByteArray": {
    accessors: {
      length: {
        get: function(this: any) {
          return byteState(this, "ByteArray.length").length;
        },
        set: function(this: any, value: number) {
          const state = byteState(this, "ByteArray.length");
          if (!(value >= 0)) throw new RangeError("The supplied index is out of bounds.");
          const length = value >>> 0;
          byteReserve(state, length);
          if (length > state.length) state.bytes.fill(0, state.length, length);
          state.length = length;
          if (state.position > length) state.position = length;
        },
      },
      position: {
        get: function(this: any) {
          return byteState(this, "ByteArray.position").position;
        },
        set: function(this: any, value: number) {
          const state = byteState(this, "ByteArray.position");
          if (!(value >= 0)) throw new RangeError("The supplied index is out of bounds.");
          state.position = value >>> 0;
        },
      },
      bytesAvailable: {
        get: function(this: any) {
          const state = byteState(this, "ByteArray.bytesAvailable");
          return Math.max(0, state.length - state.position);
        },
      },
      endian: {
        get: function(this: any) {
          return byteState(this, "ByteArray.endian").little ? "littleEndian" : "bigEndian";
        },
        set: function(this: any, value: string) {
          if (value !== "bigEndian" && value !== "littleEndian") {
            throw new TypeError("Parameter endian must be one of the accepted values.");
          }
          byteState(this, "ByteArray.endian").little = value === "littleEndian";
        },
      },
      objectEncoding: {
        get: function(this: any) {
          return byteState(this, "ByteArray.objectEncoding").objectEncoding;
        },
        set: function(this: any, value: number) {
          const encoding = value | 0;
          if (encoding !== 0 && encoding !== 3) {
            throw new AS3RuntimeError("ByteArray.objectEncoding", `Unsupported object encoding ${encoding}`);
          }
          byteState(this, "ByteArray.objectEncoding").objectEncoding = encoding;
        },
      },
    },
    methods: {
      readBoolean: function(this: any) {
        const state = byteState(this, "ByteArray.readBoolean");
        byteTake(state, 1, "readBoolean");
        return state.bytes[state.position++] !== 0;
      },
      readByte: function(this: any) {
        const state = byteState(this, "ByteArray.readByte");
        byteTake(state, 1, "readByte");
        return state.view.getInt8(state.position++);
      },
      readUnsignedByte: function(this: any) {
        const state = byteState(this, "ByteArray.readUnsignedByte");
        byteTake(state, 1, "readUnsignedByte");
        return state.bytes[state.position++]!;
      },
      readShort: function(this: any) {
        const state = byteState(this, "ByteArray.readShort");
        byteTake(state, 2, "readShort");
        const value = state.view.getInt16(state.position, state.little);
        state.position += 2;
        return value;
      },
      readUnsignedShort: function(this: any) {
        const state = byteState(this, "ByteArray.readUnsignedShort");
        byteTake(state, 2, "readUnsignedShort");
        const value = state.view.getUint16(state.position, state.little);
        state.position += 2;
        return value;
      },
      readInt: function(this: any) {
        const state = byteState(this, "ByteArray.readInt");
        byteTake(state, 4, "readInt");
        const value = state.view.getInt32(state.position, state.little);
        state.position += 4;
        return value;
      },
      readUnsignedInt: function(this: any) {
        const state = byteState(this, "ByteArray.readUnsignedInt");
        byteTake(state, 4, "readUnsignedInt");
        const value = state.view.getUint32(state.position, state.little);
        state.position += 4;
        return value;
      },
      readFloat: function(this: any) {
        const state = byteState(this, "ByteArray.readFloat");
        byteTake(state, 4, "readFloat");
        const value = state.view.getFloat32(state.position, state.little);
        state.position += 4;
        return value;
      },
      readDouble: function(this: any) {
        const state = byteState(this, "ByteArray.readDouble");
        byteTake(state, 8, "readDouble");
        const value = state.view.getFloat64(state.position, state.little);
        state.position += 8;
        return value;
      },
      readBytes: function(this: any, bytes: any, offset = 0, length = 0) {
        const state = byteState(this, "ByteArray.readBytes");
        const target = byteState(bytes, "ByteArray.readBytes");
        const count = length === 0 ? Math.max(0, state.length - state.position) : length;
        byteTake(state, count, "readBytes");
        const end = offset + count;
        if (target.length < end) {
          byteReserve(target, end);
          if (end > target.length) target.bytes.fill(0, target.length, end);
          target.length = end;
        }
        target.bytes.set(state.bytes.subarray(state.position, state.position + count), offset);
        state.position += count;
      },
      readUTF: function(this: any) {
        return this.readUTFBytes(this.readUnsignedShort());
      },
      readUTFBytes: function(this: any, length: number) {
        const state = byteState(this, "ByteArray.readUTFBytes");
        byteTake(state, length, "readUTFBytes");
        let start = state.position;
        const end = start + length;
        state.position = end;
        if (length >= 3 && state.bytes[start] === 0xef && state.bytes[start + 1] === 0xbb && state.bytes[start + 2] === 0xbf) {
          start += 3;
        }
        let stop = state.bytes.indexOf(0, start);
        if (stop < 0 || stop > end) stop = end;
        return utf8Decoder.decode(state.bytes.subarray(start, stop));
      },
      readMultiByte: function(this: any, length: number, charSet: string) {
        const state = byteState(this, "ByteArray.readMultiByte");
        byteTake(state, length, "readMultiByte");
        const slice = state.bytes.subarray(state.position, state.position + length);
        state.position += length;
        let decoder = utf8Decoder;
        try {
          decoder = new TextDecoder(charSet);
        } catch {
          decoder = utf8Decoder;
        }
        const text = decoder.decode(slice);
        const nul = text.indexOf("\0");
        return nul < 0 ? text : text.slice(0, nul);
      },
      readObject: function() {
        throw new AS3RuntimeError("ByteArray.readObject", "AMF3 object reading is not implemented");
      },
      writeBoolean: function(this: any, value: boolean) {
        const state = byteState(this, "ByteArray.writeBoolean");
        bytePut(state, 1);
        state.bytes[state.position++] = value ? 1 : 0;
      },
      writeByte: function(this: any, value: number) {
        const state = byteState(this, "ByteArray.writeByte");
        bytePut(state, 1);
        state.bytes[state.position++] = value & 0xff;
      },
      writeUnsignedByte: function(this: any, value: number) {
        const state = byteState(this, "ByteArray.writeUnsignedByte");
        bytePut(state, 1);
        state.bytes[state.position++] = value & 0xff;
      },
      writeShort: function(this: any, value: number) {
        const state = byteState(this, "ByteArray.writeShort");
        bytePut(state, 2);
        state.view.setUint16(state.position, value & 0xffff, state.little);
        state.position += 2;
      },
      writeInt: function(this: any, value: number) {
        const state = byteState(this, "ByteArray.writeInt");
        bytePut(state, 4);
        state.view.setInt32(state.position, value | 0, state.little);
        state.position += 4;
      },
      writeUnsignedInt: function(this: any, value: number) {
        const state = byteState(this, "ByteArray.writeUnsignedInt");
        bytePut(state, 4);
        state.view.setUint32(state.position, value >>> 0, state.little);
        state.position += 4;
      },
      writeFloat: function(this: any, value: number) {
        const state = byteState(this, "ByteArray.writeFloat");
        bytePut(state, 4);
        state.view.setFloat32(state.position, value, state.little);
        state.position += 4;
      },
      writeDouble: function(this: any, value: number) {
        const state = byteState(this, "ByteArray.writeDouble");
        bytePut(state, 8);
        state.view.setFloat64(state.position, value, state.little);
        state.position += 8;
      },
      writeBytes: function(this: any, bytes: any, offset = 0, length = 0) {
        const state = byteState(this, "ByteArray.writeBytes");
        const source = byteState(bytes, "ByteArray.writeBytes");
        const count = length === 0 ? Math.max(0, source.length - offset) : length;
        if (offset + count > source.length) throw new RangeError("The supplied index is out of bounds.");
        const chunk = source.bytes.slice(offset, offset + count);
        byteWriteRaw(state, chunk);
      },
      writeUTF: function(this: any, value: string) {
        const data = utf8Encoder.encode(String(value ?? ""));
        if (data.length > 0xffff) throw new RangeError("The supplied index is out of bounds.");
        this.writeShort(data.length);
        byteWriteRaw(byteState(this, "ByteArray.writeUTF"), data);
      },
      writeUTFBytes: function(this: any, value: string) {
        byteWriteRaw(byteState(this, "ByteArray.writeUTFBytes"), utf8Encoder.encode(String(value ?? "")));
      },
      writeMultiByte: function(this: any, value: string, charSet: string) {
        byteWriteRaw(byteState(this, "ByteArray.writeMultiByte"), encodeCharset(String(value ?? ""), charSet));
      },
      writeObject: function() {
        throw new AS3RuntimeError("ByteArray.writeObject", "AMF3 object writing is not implemented");
      },
      compress: function(this: any, algorithm = "zlib") {
        const state = byteState(this, "ByteArray.compress");
        const kind = compressionKind(algorithm, "ByteArray.compress");
        const source = state.bytes.slice(0, state.length);
        byteReplace(state, kind === "deflate" ? deflateRaw(source) : zlibCompress(source));
      },
      uncompress: function(this: any, algorithm = "zlib") {
        const state = byteState(this, "ByteArray.uncompress");
        const kind = compressionKind(algorithm, "ByteArray.uncompress");
        const source = state.bytes.slice(0, state.length);
        let raw: Uint8Array;
        try {
          raw = kind === "deflate" ? inflateRaw(source) : zlibDecompress(source);
        } catch {
          // Flash reports corrupt input as an IOError and leaves the contents untouched.
          throw $error("IOError", "There was an error decompressing the data.");
        }
        byteReplace(state, raw);
      },
      deflate: function(this: any) {
        const state = byteState(this, "ByteArray.deflate");
        byteReplace(state, deflateRaw(state.bytes.slice(0, state.length)));
      },
      inflate: function(this: any) {
        const state = byteState(this, "ByteArray.inflate");
        const source = state.bytes.slice(0, state.length);
        let raw: Uint8Array;
        try {
          raw = inflateRaw(source);
        } catch {
          throw $error("IOError", "There was an error decompressing the data.");
        }
        byteReplace(state, raw);
      },
      clear: function(this: any) {
        const bytes = new Uint8Array(16);
        byteArrayStates.set(this, {
          bytes,
          view: new DataView(bytes.buffer),
          length: 0,
          position: 0,
          little: false,
          objectEncoding: 3,
        });
      },
      toString: function(this: any) {
        const state = byteState(this, "ByteArray.toString");
        const bytes = state.bytes.subarray(0, state.length);
        if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) return decodeUtf16(bytes.subarray(2), false);
        if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) return decodeUtf16(bytes.subarray(2), true);
        if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return utf8Decoder.decode(bytes.subarray(3));
        return utf8Decoder.decode(bytes);
      },
    },
    staticValues: { defaultObjectEncoding: 3 },
    init(target) {
      const bytes = new Uint8Array(16);
      const defaultEncoding = $runtimeClass("flash.utils.ByteArray").defaultObjectEncoding;
      byteArrayStates.set(target, {
        bytes,
        view: new DataView(bytes.buffer),
        length: 0,
        position: 0,
        little: false,
        objectEncoding: typeof defaultEncoding === "number" ? defaultEncoding : 3,
      });
    },
  },
  "flash.utils.Dictionary": {
    dynamic: true,
    methods: {
      has: function(this: any, key: any) {
        return dictionaryMap(this, "Dictionary.has").has(dictionaryKey(key));
      },
      get: function(this: any, key: any) {
        return dictionaryMap(this, "Dictionary.get").get(dictionaryKey(key));
      },
      set: function(this: any, key: any, value: any) {
        dictionaryMap(this, "Dictionary.set").set(dictionaryKey(key), value);
      },
      remove: function(this: any, key: any) {
        return dictionaryMap(this, "Dictionary.remove").delete(dictionaryKey(key));
      },
    },
    create(target) {
      const map = new Map<any, any>();
      const proxy = new Proxy(target, {
        get(object, property, receiver) {
          if (typeof property !== "symbol") {
            const key = dictionaryKey(property);
            if (map.has(key)) return map.get(key);
          }
          return Reflect.get(object, property, receiver);
        },
        set(object, property, value) {
          if (typeof property === "symbol") return Reflect.set(object, property, value);
          map.set(dictionaryKey(property), value);
          return true;
        },
        deleteProperty(object, property) {
          if (typeof property === "symbol") return Reflect.deleteProperty(object, property);
          map.delete(dictionaryKey(property));
          return true;
        },
        has(object, property) {
          return map.has(dictionaryKey(property)) || Reflect.has(object, property);
        },
        ownKeys() {
          return [...map.keys()].map((key) => String(key));
        },
        getOwnPropertyDescriptor(object, property) {
          if (map.has(property)) {
            return { value: map.get(property), enumerable: true, configurable: true, writable: true };
          }
          return Reflect.getOwnPropertyDescriptor(object, property);
        },
      });
      dictionaryMaps.set(proxy, map);
      return proxy;
    },
  },
  "flash.geom.Point": {
    fields: { x: { type: "Number" }, y: { type: "Number" } },
    accessors: {
      length: {
        get: function(this: any) {
          return Math.sqrt(this.x * this.x + this.y * this.y);
        },
      },
    },
    methods: {
      add: function(this: any, other: any) {
        return runtimeNew("flash.geom.Point", this.x + other.x, this.y + other.y);
      },
      subtract: function(this: any, other: any) {
        return runtimeNew("flash.geom.Point", this.x - other.x, this.y - other.y);
      },
      offset: function(this: any, dx: number, dy: number) {
        this.x += dx;
        this.y += dy;
      },
      clone: function(this: any) {
        return runtimeNew("flash.geom.Point", this.x, this.y);
      },
      equals: function(this: any, other: any) {
        return other != null && this.x === other.x && this.y === other.y;
      },
      setTo: function(this: any, x: number, y: number) {
        this.x = x;
        this.y = y;
      },
      toString: function(this: any) {
        return `(x=${this.x}, y=${this.y})`;
      },
    },
    statics: {
      distance: (first: any, second: any) => {
        const dx = second.x - first.x;
        const dy = second.y - first.y;
        return Math.sqrt(dx * dx + dy * dy);
      },
      interpolate: (first: any, second: any, fraction: number) =>
        runtimeNew(
          "flash.geom.Point",
          second.x + fraction * (first.x - second.x),
          second.y + fraction * (first.y - second.y),
        ),
      polar: (length: number, angle: number) =>
        runtimeNew("flash.geom.Point", length * Math.cos(angle), length * Math.sin(angle)),
    },
    init(target, args) {
      target.x = args[0] === undefined ? 0 : Number(args[0]);
      target.y = args[1] === undefined ? 0 : Number(args[1]);
    },
  },
  "flash.geom.Rectangle": {
    fields: {
      x: { type: "Number" },
      y: { type: "Number" },
      width: { type: "Number" },
      height: { type: "Number" },
    },
    accessors: {
      left: {
        get: function(this: any) {
          return this.x;
        },
        set: function(this: any, value: number) {
          this.width += this.x - value;
          this.x = value;
        },
      },
      right: {
        get: function(this: any) {
          return this.x + this.width;
        },
        set: function(this: any, value: number) {
          this.width = value - this.x;
        },
      },
      top: {
        get: function(this: any) {
          return this.y;
        },
        set: function(this: any, value: number) {
          this.height += this.y - value;
          this.y = value;
        },
      },
      bottom: {
        get: function(this: any) {
          return this.y + this.height;
        },
        set: function(this: any, value: number) {
          this.height = value - this.y;
        },
      },
      topLeft: {
        get: function(this: any) {
          return runtimeNew("flash.geom.Point", this.x, this.y);
        },
        set: function(this: any, value: any) {
          this.width += this.x - value.x;
          this.height += this.y - value.y;
          this.x = value.x;
          this.y = value.y;
        },
      },
      bottomRight: {
        get: function(this: any) {
          return runtimeNew("flash.geom.Point", this.x + this.width, this.y + this.height);
        },
        set: function(this: any, value: any) {
          this.width = value.x - this.x;
          this.height = value.y - this.y;
        },
      },
      size: {
        get: function(this: any) {
          return runtimeNew("flash.geom.Point", this.width, this.height);
        },
        set: function(this: any, value: any) {
          this.width = value.x;
          this.height = value.y;
        },
      },
    },
    methods: {
      clone: function(this: any) {
        return runtimeNew("flash.geom.Rectangle", this.x, this.y, this.width, this.height);
      },
      contains: function(this: any, x: number, y: number) {
        return x >= this.x && x < this.x + this.width && y >= this.y && y < this.y + this.height;
      },
      containsPoint: function(this: any, point: any) {
        return this.contains(point.x, point.y);
      },
      containsRect: function(this: any, rect: any) {
        if (rect.isEmpty()) return false;
        return rect.x >= this.x && rect.y >= this.y && rect.right <= this.right && rect.bottom <= this.bottom;
      },
      equals: function(this: any, other: any) {
        return other != null && this.x === other.x && this.y === other.y
          && this.width === other.width && this.height === other.height;
      },
      isEmpty: function(this: any) {
        return this.width <= 0 || this.height <= 0;
      },
      setEmpty: function(this: any) {
        this.x = 0;
        this.y = 0;
        this.width = 0;
        this.height = 0;
      },
      setTo: function(this: any, x: number, y: number, width: number, height: number) {
        this.x = x;
        this.y = y;
        this.width = width;
        this.height = height;
      },
      intersection: function(this: any, other: any) {
        if (this.isEmpty() || other.isEmpty()) return runtimeNew("flash.geom.Rectangle");
        const left = Math.max(this.x, other.x);
        const top = Math.max(this.y, other.y);
        const right = Math.min(this.right, other.right);
        const bottom = Math.min(this.bottom, other.bottom);
        if (right <= left || bottom <= top) return runtimeNew("flash.geom.Rectangle");
        return runtimeNew("flash.geom.Rectangle", left, top, right - left, bottom - top);
      },
      intersects: function(this: any, other: any) {
        return !this.intersection(other).isEmpty();
      },
      union: function(this: any, other: any) {
        if (this.isEmpty()) return other.clone();
        if (other.isEmpty()) return this.clone();
        const left = Math.min(this.x, other.x);
        const top = Math.min(this.y, other.y);
        return runtimeNew(
          "flash.geom.Rectangle",
          left,
          top,
          Math.max(this.right, other.right) - left,
          Math.max(this.bottom, other.bottom) - top,
        );
      },
      inflate: function(this: any, dx: number, dy: number) {
        this.x -= dx;
        this.width += 2 * dx;
        this.y -= dy;
        this.height += 2 * dy;
      },
      inflatePoint: function(this: any, point: any) {
        this.inflate(point.x, point.y);
      },
      offset: function(this: any, dx: number, dy: number) {
        this.x += dx;
        this.y += dy;
      },
      offsetPoint: function(this: any, point: any) {
        this.x += point.x;
        this.y += point.y;
      },
      toString: function(this: any) {
        return `(x=${this.x}, y=${this.y}, w=${this.width}, h=${this.height})`;
      },
    },
    init(target, args) {
      target.x = args[0] === undefined ? 0 : Number(args[0]);
      target.y = args[1] === undefined ? 0 : Number(args[1]);
      target.width = args[2] === undefined ? 0 : Number(args[2]);
      target.height = args[3] === undefined ? 0 : Number(args[3]);
    },
  },
  "flash.geom.Matrix": {
    fields: {
      a: { type: "Number" },
      b: { type: "Number" },
      c: { type: "Number" },
      d: { type: "Number" },
      tx: { type: "Number" },
      ty: { type: "Number" },
    },
    methods: {
      clone: function(this: any) {
        return runtimeNew("flash.geom.Matrix", this.a, this.b, this.c, this.d, this.tx, this.ty);
      },
      identity: function(this: any) {
        this.setTo(1, 0, 0, 1, 0, 0);
      },
      setTo: function(this: any, a: number, b: number, c: number, d: number, tx: number, ty: number) {
        this.a = a;
        this.b = b;
        this.c = c;
        this.d = d;
        this.tx = tx;
        this.ty = ty;
      },
      concat: function(this: any, m: any) {
        const a = this.a * m.a + this.b * m.c;
        const b = this.a * m.b + this.b * m.d;
        const c = this.c * m.a + this.d * m.c;
        const d = this.c * m.b + this.d * m.d;
        const tx = this.tx * m.a + this.ty * m.c + m.tx;
        const ty = this.tx * m.b + this.ty * m.d + m.ty;
        this.setTo(a, b, c, d, tx, ty);
      },
      invert: function(this: any) {
        const det = this.a * this.d - this.b * this.c;
        const a = this.d / det;
        const b = -this.b / det;
        const c = -this.c / det;
        const d = this.a / det;
        const tx = -(a * this.tx + c * this.ty);
        const ty = -(b * this.tx + d * this.ty);
        this.setTo(a, b, c, d, tx, ty);
      },
      rotate: function(this: any, angle: number) {
        const cos = Math.cos(angle);
        const sin = Math.sin(angle);
        this.setTo(
          this.a * cos - this.b * sin, this.a * sin + this.b * cos,
          this.c * cos - this.d * sin, this.c * sin + this.d * cos,
          this.tx * cos - this.ty * sin, this.tx * sin + this.ty * cos,
        );
      },
      scale: function(this: any, sx: number, sy: number) {
        this.a *= sx;
        this.b *= sy;
        this.c *= sx;
        this.d *= sy;
        this.tx *= sx;
        this.ty *= sy;
      },
      translate: function(this: any, dx: number, dy: number) {
        this.tx += dx;
        this.ty += dy;
      },
      createBox: function(this: any, scaleX: number, scaleY: number, rotation = 0, tx = 0, ty = 0) {
        const cos = Math.cos(rotation);
        const sin = Math.sin(rotation);
        this.setTo(cos * scaleX, sin * scaleY, -sin * scaleX, cos * scaleY, tx, ty);
      },
      createGradientBox: function(this: any, width: number, height: number, rotation = 0, tx = 0, ty = 0) {
        this.createBox(width / 1638.4, height / 1638.4, rotation, tx + width / 2, ty + height / 2);
      },
      transformPoint: function(this: any, point: any) {
        return runtimeNew(
          "flash.geom.Point",
          this.a * point.x + this.c * point.y + this.tx,
          this.b * point.x + this.d * point.y + this.ty,
        );
      },
      deltaTransformPoint: function(this: any, point: any) {
        return runtimeNew(
          "flash.geom.Point",
          this.a * point.x + this.c * point.y,
          this.b * point.x + this.d * point.y,
        );
      },
      transformVectors: function(this: any, point: any) {
        const x = point.x;
        const y = point.y;
        point.x = this.a * x + this.c * y;
        point.y = this.b * x + this.d * y;
      },
      toString: function(this: any) {
        return `(a=${this.a}, b=${this.b}, c=${this.c}, d=${this.d}, tx=${this.tx}, ty=${this.ty})`;
      },
    },
    init(target, args) {
      target.a = args[0] === undefined ? 1 : Number(args[0]);
      target.b = args[1] === undefined ? 0 : Number(args[1]);
      target.c = args[2] === undefined ? 0 : Number(args[2]);
      target.d = args[3] === undefined ? 1 : Number(args[3]);
      target.tx = args[4] === undefined ? 0 : Number(args[4]);
      target.ty = args[5] === undefined ? 0 : Number(args[5]);
    },
  },
  "flash.geom.ColorTransform": {
    fields: {
      redMultiplier: { type: "Number" },
      greenMultiplier: { type: "Number" },
      blueMultiplier: { type: "Number" },
      alphaMultiplier: { type: "Number" },
      redOffset: { type: "Number" },
      greenOffset: { type: "Number" },
      blueOffset: { type: "Number" },
      alphaOffset: { type: "Number" },
    },
    accessors: {
      color: {
        get: function(this: any) {
          return ((this.redOffset << 16) | (this.greenOffset << 8) | this.blueOffset) >>> 0;
        },
        set: function(this: any, value: number) {
          this.redMultiplier = 0;
          this.greenMultiplier = 0;
          this.blueMultiplier = 0;
          this.redOffset = (value >> 16) & 0xff;
          this.greenOffset = (value >> 8) & 0xff;
          this.blueOffset = value & 0xff;
        },
      },
    },
    methods: {
      concat: function(this: any, second: any) {
        this.redOffset += this.redMultiplier * second.redOffset;
        this.greenOffset += this.greenMultiplier * second.greenOffset;
        this.blueOffset += this.blueMultiplier * second.blueOffset;
        this.alphaOffset += this.alphaMultiplier * second.alphaOffset;
        this.redMultiplier *= second.redMultiplier;
        this.greenMultiplier *= second.greenMultiplier;
        this.blueMultiplier *= second.blueMultiplier;
        this.alphaMultiplier *= second.alphaMultiplier;
      },
      toString: function(this: any) {
        return `(redMultiplier=${this.redMultiplier}, greenMultiplier=${this.greenMultiplier}, blueMultiplier=${this.blueMultiplier}, alphaMultiplier=${this.alphaMultiplier})`;
      },
    },
    init(target, args) {
      target.redMultiplier = args[0] === undefined ? 1 : Number(args[0]);
      target.greenMultiplier = args[1] === undefined ? 1 : Number(args[1]);
      target.blueMultiplier = args[2] === undefined ? 1 : Number(args[2]);
      target.alphaMultiplier = args[3] === undefined ? 1 : Number(args[3]);
      target.redOffset = args[4] === undefined ? 0 : Number(args[4]);
      target.greenOffset = args[5] === undefined ? 0 : Number(args[5]);
      target.blueOffset = args[6] === undefined ? 0 : Number(args[6]);
      target.alphaOffset = args[7] === undefined ? 0 : Number(args[7]);
    },
  },
  "flash.geom.Transform": {
    accessors: {
      matrix: {
        get: function(this: any) {
          return displayObjectMatrix(this.__owner);
        },
        set: function(this: any, value: any) {
          if (!value || typeof value !== "object") {
            throw new AS3RuntimeError("Transform.matrix", "A Matrix is required");
          }
          applyDisplayObjectMatrix(this.__owner, value);
        },
      },
      colorTransform: {
        get: function(this: any) {
          let value = this.__owner.__colorTransform;
          if (!value || typeof value !== "object") {
            value = this.__owner.__colorTransform = runtimeNew("flash.geom.ColorTransform");
          }
          return value;
        },
        set: function(this: any, value: any) {
          if (!value || typeof value !== "object") {
            throw new AS3RuntimeError("Transform.colorTransform", "A ColorTransform is required");
          }
          this.__owner.__colorTransform = value;
        },
      },
      concatenatedMatrix: {
        get: function(this: any) {
          return concatenatedDisplayMatrix(this.__owner);
        },
      },
    },
    init(target, args) {
      const owner = args?.[0];
      if (!owner || typeof owner !== "object") {
        throw new AS3RuntimeError("Transform", "A DisplayObject is required");
      }
      target.__owner = owner;
    },
  },
  "flash.events.ErrorEvent": {
    fields: { text: { type: "String" }, ID: { type: "int" } },
    staticValues: { ERROR: "error" },
    init(target, args) {
      target.text = args[3] === undefined ? "" : String(args[3]);
      target.ID = 0;
    },
  },
  "flash.events.IOErrorEvent": {
    staticValues: { IO_ERROR: "ioError" },
  },
  "flash.events.ProgressEvent": {
    fields: { bytesLoaded: { type: "Number" }, bytesTotal: { type: "Number" } },
    staticValues: { PROGRESS: "progress", SOCKET_DATA: "socketData" },
    init(target, args) {
      target.bytesLoaded = args[3] === undefined ? 0 : Number(args[3]);
      target.bytesTotal = args[4] === undefined ? 0 : Number(args[4]);
    },
  },
  "flash.events.FocusEvent": {
    fields: {
      relatedObject: { type: "Object" },
      shiftKey: { type: "Boolean" },
      keyCode: { type: "int" },
      keyLocation: { type: "int" },
    },
    staticValues: {
      FOCUS_IN: "focusIn",
      FOCUS_OUT: "focusOut",
      KEY_FOCUS_CHANGE: "keyFocusChange",
      MOUSE_FOCUS_CHANGE: "mouseFocusChange",
    },
    init(target, args) {
      target.relatedObject = args[3] ?? null;
      target.shiftKey = Boolean(args[4] ?? false);
      target.keyCode = args[5] === undefined ? 0 : Number(args[5]) | 0;
      target.keyLocation = args[6] === undefined ? 0 : Number(args[6]) | 0;
    },
  },
  "flash.events.KeyboardEvent": {
    fields: {
      charCode: { type: "int" },
      keyCode: { type: "int" },
      keyLocation: { type: "int" },
      ctrlKey: { type: "Boolean" },
      altKey: { type: "Boolean" },
      shiftKey: { type: "Boolean" },
      commandKey: { type: "Boolean" },
      controlKey: { type: "Boolean" },
    },
    staticValues: { KEY_DOWN: "keyDown", KEY_UP: "keyUp" },
    methods: {
      updateAfterEvent: function() {},
    },
    init(target, args) {
      target.charCode = args[3] === undefined ? 0 : Number(args[3]) | 0;
      target.keyCode = args[4] === undefined ? 0 : Number(args[4]) | 0;
      target.keyLocation = args[5] === undefined ? 0 : Number(args[5]) | 0;
      target.ctrlKey = Boolean(args[6] ?? false);
      target.altKey = Boolean(args[7] ?? false);
      target.shiftKey = Boolean(args[8] ?? false);
      target.controlKey = target.ctrlKey;
      target.commandKey = false;
    },
  },
  "flash.events.TextEvent": {
    fields: {
      text: { type: "String" },
    },
    staticValues: {
      TEXT_INPUT: "textInput",
      LINK: "link",
    },
    init(target, args) {
      target.text = args[3] === undefined ? "" : String(args[3]);
    },
  },
  "flash.events.MouseEvent": {
    fields: {
      localX: { type: "Number" },
      localY: { type: "Number" },
      stageX: { type: "Number" },
      stageY: { type: "Number" },
      movementX: { type: "Number" },
      movementY: { type: "Number" },
      buttonDown: { type: "Boolean" },
      delta: { type: "int" },
      clickCount: { type: "int" },
      relatedObject: { type: "Object" },
      altKey: { type: "Boolean" },
      ctrlKey: { type: "Boolean" },
      commandKey: { type: "Boolean" },
      controlKey: { type: "Boolean" },
      shiftKey: { type: "Boolean" },
    },
    staticValues: {
      CLICK: "click",
      CONTEXT_MENU: "contextMenu",
      DOUBLE_CLICK: "doubleClick",
      MIDDLE_CLICK: "middleClick",
      MIDDLE_MOUSE_DOWN: "middleMouseDown",
      MIDDLE_MOUSE_UP: "middleMouseUp",
      MOUSE_DOWN: "mouseDown",
      MOUSE_MOVE: "mouseMove",
      MOUSE_OUT: "mouseOut",
      MOUSE_OVER: "mouseOver",
      MOUSE_UP: "mouseUp",
      MOUSE_WHEEL: "mouseWheel",
      RIGHT_CLICK: "rightClick",
      RIGHT_MOUSE_DOWN: "rightMouseDown",
      RIGHT_MOUSE_UP: "rightMouseUp",
      ROLL_OUT: "rollOut",
      ROLL_OVER: "rollOver",
    },
    methods: {
      updateAfterEvent: function() {},
    },
    init(target, args) {
      target.localX = args[3] === undefined ? 0 : Number(args[3]);
      target.localY = args[4] === undefined ? 0 : Number(args[4]);
      target.stageX = target.localX;
      target.stageY = target.localY;
      target.movementX = args[13] === undefined ? 0 : Number(args[13]);
      target.movementY = args[14] === undefined ? 0 : Number(args[14]);
      target.relatedObject = args[5] ?? null;
      target.ctrlKey = Boolean(args[6] ?? false);
      target.altKey = Boolean(args[7] ?? false);
      target.shiftKey = Boolean(args[8] ?? false);
      target.buttonDown = Boolean(args[9] ?? false);
      target.delta = args[10] === undefined ? 0 : Number(args[10]) | 0;
      target.commandKey = Boolean(args[11] ?? false);
      target.controlKey = target.ctrlKey;
      target.clickCount = args[12] === undefined ? 0 : Number(args[12]) | 0;
    },
  },
  "flash.events.HTTPStatusEvent": {
    fields: { status: { type: "int" } },
    staticValues: { HTTP_STATUS: "httpStatus", HTTP_RESPONSE_STATUS: "httpResponseStatus" },
    init(target, args) {
      target.status = args[3] === undefined ? 0 : Number(args[3]) | 0;
    },
  },
  "flash.events.SecurityErrorEvent": {
    staticValues: { SECURITY_ERROR: "securityError" },
  },
  "flash.events.UncaughtErrorEvent": {
    fields: { error: { type: "Object" } },
    staticValues: { UNCAUGHT_ERROR: "uncaughtError" },
    init(target, args) {
      target.error = args[3] ?? null;
    },
  },
  "flash.external.ExternalInterface": {
    staticValues: { objectID: "", marshallExceptions: false },
    staticAccessors: {
      available: { get: () => externalInterfaceAvailable() },
    },
    statics: {
      addCallback: function(name: string, closure: any) {
        if (typeof closure === "function") {
          externalCallbacks.set(name, closure);
          (globalThis as any)[name] = (...args: any[]) => closure(...args);
        } else {
          externalCallbacks.delete(name);
          delete (globalThis as any)[name];
        }
      },
      call: function(name: string, ...args: any[]) {
        const target = externalInterfaceFunction(name);
        if (!target) {
          if (!externalInterfaceObject()) {
            throw new AS3RuntimeError(
              "flash.external.ExternalInterface.call",
              `No host bridge is configured for '${name}'`,
            );
          }
          // A configured host may expose only the methods it implements.
          return null;
        }
        return target.fn.apply(target.owner, args);
      },
    },
  },
  "flash.system.Capabilities": {
    staticValues: {
      playerType: "PlugIn",
      version: capabilitiesVersion(),
      isDebugger: false,
      language: capabilitiesLanguage(),
      screenResolutionX: capabilitiesScreenWidth(),
      screenResolutionY: capabilitiesScreenHeight(),
      pixelAspectRatio: 1,
      hasEmbeddedVideo: true,
      hasAudio: true,
      serverString: capabilitiesServerString(),
      os: capabilitiesOs(),
      manufacturer: "Adobe",
      hasPrinting: false,
      hasIME: false,
    },
  },
  "flash.system.ApplicationDomain": {
    staticAccessors: {
      currentDomain: { get: () => currentApplicationDomain() },
    },
    methods: {
      getDefinition: function(this: any, name: string) {
        const fqcn = String(name);
        const definition = swfDefinitions(this).get(fqcn) ?? $getClass(fqcn);
        if (!definition) throw $error("ReferenceError", `Definition ${fqcn} was not found.`);
        return definition;
      },
      hasDefinition: function(this: any, name: string) {
        const fqcn = String(name);
        return swfDefinitions(this).has(fqcn) || $getClass(fqcn) !== null;
      },
    },
  },
  "flash.system.SecurityDomain": {
    staticAccessors: {
      currentDomain: { get: () => currentSecurityDomain() },
    },
  },
  "flash.system.LoaderContext": {
    fields: {
      checkPolicyFile: { type: "Boolean" },
      applicationDomain: { type: "flash.system.ApplicationDomain" },
      parameters: { type: "Object" },
    },
    init(target, args) {
      target.checkPolicyFile = Boolean(args[0] ?? false);
      target.applicationDomain = args[1] ?? currentApplicationDomain();
      target.parameters = {};
    },
  },
  "flash.system.System": {
    staticValues: {
      totalMemory: 0,
      freeMemory: 0,
      privateMemory: 0,
      useCodePage: false,
    },
    statics: {
      gc: function() {},
      pauseForGCIfCollectionImminent: function() {},
      disposeXML: function() {},
      setClipboard: function(value: string) {
        const clipboard = (globalThis as any).navigator?.clipboard;
        if (clipboard?.writeText) {
          void Promise.resolve(clipboard.writeText(String(value))).catch(() => {});
        }
      },
    },
  },
  "flash.system.Security": {
    staticValues: {
      LOCAL_TRUSTED: "localTrusted",
      LOCAL_WITH_FILE: "localWithFile",
      LOCAL_WITH_NETWORK: "localWithNetwork",
      REMOTE: "remote",
      sandboxType: "remote",
    },
    statics: {
      allowDomain: function() {},
      allowInsecureDomain: function() {},
      loadPolicyFile: function() {},
      showSettings: function() {},
    },
  },
  "flash.net.Socket": {
    accessors: {
      connected: {
        get: function(this: any) {
          return socketState(this, "Socket.connected").connected;
        },
      },
      bytesAvailable: {
        get: function(this: any) {
          return socketState(this, "Socket.bytesAvailable").receive.bytesAvailable;
        },
      },
      endian: {
        get: function(this: any) {
          return socketState(this, "Socket.endian").send.endian;
        },
        set: function(this: any, value: string) {
          const state = socketState(this, "Socket.endian");
          state.receive.endian = value;
          state.send.endian = value;
        },
      },
      objectEncoding: {
        get: function(this: any) {
          return socketState(this, "Socket.objectEncoding").send.objectEncoding;
        },
        set: function(this: any, value: number) {
          const state = socketState(this, "Socket.objectEncoding");
          state.receive.objectEncoding = value;
          state.send.objectEncoding = value;
        },
      },
      timeout: {
        get: function(this: any) {
          return socketState(this, "Socket.timeout").timeout;
        },
        set: function(this: any, value: number) {
          if (!(value >= 0)) throw new RangeError("The supplied index is out of bounds.");
          socketState(this, "Socket.timeout").timeout = value;
        },
      },
    },
    methods: {
      ...socketReadMethods("Socket"),
      ...socketWriteMethods("Socket"),
      connect: function(this: any, host: string, port: number) {
        const state = socketState(this, "Socket.connect");
        if (state.webSocket) throw new AS3RuntimeError("Socket.connect", "Socket is already connecting or connected");
        const targetPort = Number(port);
        if (!Number.isInteger(targetPort) || targetPort < 0 || targetPort > 65535) {
          // A missing port (an out-of-range index in a client's port list) would otherwise become
          // `ws://host:NaN` and be reported as an anonymous address error. Fail like a refused port.
          const IOErrorEvent = $runtimeClass("flash.events.IOErrorEvent");
          const message = `Socket.connect: invalid port ${String(port)}`;
          state.connected = false;
          state.webSocket = null;
          queueMicrotask(() => {
            this.dispatchEvent(new IOErrorEvent(IOErrorEvent.IO_ERROR, false, false, message));
          });
          return;
        }
        const url = socketUrl(String(host), targetPort);
        let webSocket: any;
        try {
          webSocket = createWebSocket(url);
        } catch (error) {
          // Flash does not throw from Socket.connect when the transport cannot be opened; it
          // dispatches IOErrorEvent.IO_ERROR and lets the client retry or show its error UI.
          // Throwing here aborts component initialization instead.
          const IOErrorEvent = $runtimeClass("flash.events.IOErrorEvent");
          const message = `Unable to open ${url}: ${(error as Error).message}`;
          queueMicrotask(() => {
            state.connected = false;
            this.dispatchEvent(new IOErrorEvent(IOErrorEvent.IO_ERROR, false, false, message));
          });
          return;
        }
        state.webSocket = webSocket;
        webSocket.binaryType = "arraybuffer";
        const onOpen = () => {
          state.connected = true;
          const Event = $runtimeClass("flash.events.Event");
          this.dispatchEvent(new Event(Event.CONNECT));
        };
        const onMessage = (event: any) => socketInbound(this, state, event?.data);
        const onClose = () => {
          state.connected = false;
          state.webSocket = null;
          const Event = $runtimeClass("flash.events.Event");
          this.dispatchEvent(new Event(Event.CLOSE));
        };
        const onError = () => {
          state.connected = false;
          // Flash lets the client call connect() again after a failed attempt, so the closed
          // transport must not look like a live connection to the next connect().
          state.webSocket = null;
          const IOErrorEvent = $runtimeClass("flash.events.IOErrorEvent");
          this.dispatchEvent(new IOErrorEvent(IOErrorEvent.IO_ERROR, false, false, `Socket error on ${url}`));
        };
        if (typeof webSocket.addEventListener === "function") {
          webSocket.addEventListener("open", onOpen);
          webSocket.addEventListener("message", onMessage);
          webSocket.addEventListener("close", onClose);
          webSocket.addEventListener("error", onError);
        } else {
          webSocket.onopen = onOpen;
          webSocket.onmessage = onMessage;
          webSocket.onclose = onClose;
          webSocket.onerror = onError;
        }
      },
      close: function(this: any) {
        const state = socketState(this, "Socket.close");
        state.connected = false;
        state.webSocket?.close?.();
        state.webSocket = null;
      },
      flush: function(this: any) {
        const state = socketState(this, "Socket.flush");
        const bytes = socketSnapshot(state.send);
        if (bytes.length === 0) return;
        if (!state.connected) throw new AS3RuntimeError("Socket.flush", "Socket is not connected");
        state.webSocket.send(bytes);
        state.send.clear();
      },
    },
    init(target) {
      socketStates.set(target, {
        webSocket: null,
        receive: runtimeNew("flash.utils.ByteArray"),
        send: runtimeNew("flash.utils.ByteArray"),
        connected: false,
        timeout: 0,
      });
    },
  },
  "flash.events.TimerEvent": {
    staticValues: { TIMER: "timer", TIMER_COMPLETE: "timerComplete" },
  },
  "flash.utils.Timer": {
    accessors: {
      delay: {
        get: function(this: any) {
          return this.__delay;
        },
        set: function(this: any, value: number) {
          checkTimer(value, this.__repeatCount);
          this.__delay = value;
          if (this.__handle !== null) {
            clearTimer(this);
            scheduleTimer(this);
          }
        },
      },
      repeatCount: {
        get: function(this: any) {
          return this.__repeatCount;
        },
        set: function(this: any, value: number) {
          this.__repeatCount = value | 0;
          if (this.__handle !== null && this.__repeatCount > 0 && this.__currentCount >= this.__repeatCount) {
            clearTimer(this);
          }
        },
      },
      currentCount: {
        get: function(this: any) {
          return this.__currentCount;
        },
      },
      running: {
        get: function(this: any) {
          return this.__handle !== null;
        },
      },
    },
    methods: {
      start: function(this: any) {
        scheduleTimer(this);
      },
      stop: function(this: any) {
        clearTimer(this);
      },
      reset: function(this: any) {
        clearTimer(this);
        this.__currentCount = 0;
      },
    },
    init(target, args) {
      const delay = args[0] === undefined ? 0 : Number(args[0]);
      const repeatCount = args[1] === undefined ? 0 : Number(args[1]) | 0;
      checkTimer(delay, repeatCount);
      target.__delay = delay;
      target.__repeatCount = repeatCount;
      target.__currentCount = 0;
      target.__handle = null;
    },
  },
  "flash.display.DisplayObject": {
    fields: {
      x: { type: "Number" },
      y: { type: "Number" },
      alpha: { type: "Number" },
      visible: { type: "Boolean" },
      rotation: { type: "Number" },
      scaleX: { type: "Number" },
      scaleY: { type: "Number" },
      name: { type: "String" },
      stage: { type: "flash.display.Stage" },
      root: { type: "flash.display.DisplayObject" },
      loaderInfo: { type: "flash.display.LoaderInfo" },
    },
    accessors: {
      parent: {
        get: function(this: any) {
          return this.__parent ?? null;
        },
        set: function(this: any, value: any) {
          this.__parent = value ?? null;
        },
      },
      filters: {
        get: function(this: any) {
          return Array.isArray(this.__filters) ? this.__filters : [];
        },
        set: function(this: any, value: any) {
          this.__filters = value ?? [];
        },
      },
      transform: {
        // Flash hands back one Transform per display object; it is a live view of x/y/
        // rotation/scale, not a snapshot.
        get: function(this: any) {
          if (!this.__transform) this.__transform = runtimeNew("flash.geom.Transform", this);
          return this.__transform;
        },
      },
      colorTransform: {
        // One ColorTransform per display object, created on first use. The renderer reads
        // __colorTransform, so the getter must hand back that same object.
        get: function(this: any) {
          if (!this.__colorTransform) this.__colorTransform = runtimeNew("flash.geom.ColorTransform");
          return this.__colorTransform;
        },
        set: function(this: any, value: any) {
          this.__colorTransform = value ?? null;
        },
      },
      width: {
        get: function(this: any) {
          return displayWidth(this);
        },
        set: function(this: any, value: any) {
          setDisplayWidth(this, value);
        },
      },
      height: {
        get: function(this: any) {
          return displayHeight(this);
        },
        set: function(this: any, value: any) {
          setDisplayHeight(this, value);
        },
      },
    },
    methods: {
      // Flash maps through the object's own transform and then every ancestor's.
      localToGlobal: function(this: any, point: any) {
        const matrix = concatenatedDisplayMatrix(this);
        const x = Number(point?.x ?? 0);
        const y = Number(point?.y ?? 0);
        return runtimeNew(
          "flash.geom.Point",
          matrix.a * x + matrix.c * y + matrix.tx,
          matrix.b * x + matrix.d * y + matrix.ty,
        );
      },
      globalToLocal: function(this: any, point: any) {
        const matrix = concatenatedDisplayMatrix(this);
        const determinant = matrix.a * matrix.d - matrix.b * matrix.c;
        if (determinant === 0) return runtimeNew("flash.geom.Point", 0, 0);
        const dx = Number(point?.x ?? 0) - matrix.tx;
        const dy = Number(point?.y ?? 0) - matrix.ty;
        return runtimeNew(
          "flash.geom.Point",
          (matrix.d * dx - matrix.c * dy) / determinant,
          (matrix.a * dy - matrix.b * dx) / determinant,
        );
      },
    },
    init(target) {
      if (!Array.isArray(target.__children)) target.__children = [];
      target.x = 0;
      target.y = 0;
      target.__explicitWidth = null;
      target.__explicitHeight = null;
      target.alpha = 1;
      target.visible = true;
      target.rotation = 0;
      target.scaleX = 1;
      target.scaleY = 1;
      target.name = "";
      target.__parent = null;
      const isPendingRoot = pendingRootClass !== null && target.constructor === pendingRootClass;
      target.stage = isPendingRoot ? pendingRootStage : null;
      target.root = isPendingRoot ? target : null;
      target.loaderInfo = getRootLoaderInfo();
      target.__filters = [];
    },
  },
  "flash.display.DisplayObjectContainer": {
    fields: {
      mouseChildren: { type: "Boolean" },
    },
    accessors: {
      numChildren: {
        get: function(this: any) {
          return this.__children.length;
        },
      },
    },
    methods: {
      addChild: function(this: any, child: any) {
        if (!child) throw new AS3RuntimeError("DisplayObjectContainer.addChild", "Child is required");
        return this.addChildAt(child, this.__children.indexOf(child) >= 0 ? this.__children.length - 1 : this.__children.length);
      },
      addChildAt: function(this: any, child: any, index: number) {
        if (!child) throw new AS3RuntimeError("DisplayObjectContainer.addChildAt", "Child is required");
        if (child.parent === this) {
          const current = this.__children.indexOf(child);
          if (current !== index) {
            this.__children.splice(current, 1);
            this.__children.splice(Math.max(0, Math.min(index, this.__children.length)), 0, child);
          }
          return child;
        }
        if (child.__parent) child.__parent.removeChild(child);
        if (index < 0 || index > this.__children.length) {
          throw new AS3RuntimeError("DisplayObjectContainer.addChildAt", "Index out of bounds");
        }
        child.__parent = this;
        this.__children.splice(index, 0, child);
        if (this.stage) updateDisplaySubtree(child, this.stage, displayRootFor(this, child));
        const Event = $runtimeClass("flash.events.Event");
        child.dispatchEvent(new Event("added", true));
        if (this.stage) dispatchDisplaySubtree(child, "addedToStage");
        return child;
      },
      removeChild: function(this: any, child: any) {
        const index = this.__children.indexOf(child);
        if (index < 0) throw new AS3RuntimeError("DisplayObjectContainer.removeChild", "Child is not attached");
        return this.removeChildAt(index);
      },
      removeChildAt: function(this: any, index: number) {
        const child = this.__children[index];
        if (!child) throw new AS3RuntimeError("DisplayObjectContainer.removeChildAt", "Index out of bounds");
        const Event = $runtimeClass("flash.events.Event");
        child.dispatchEvent(new Event("removed", true));
        if (this.stage) dispatchDisplaySubtree(child, "removedFromStage");
        const current = this.__children.indexOf(child);
        if (current >= 0) this.__children.splice(current, 1);
        if (child.__parent === this) child.__parent = null;
        updateDisplaySubtree(child, null, null);
        return child;
      },
      removeChildren: function(this: any, beginIndex = 0, endIndex = 0x7fffffff) {
        const end = Math.min(endIndex, this.__children.length - 1);
        for (let index = end; index >= beginIndex; index -= 1) this.removeChildAt(index);
      },
      getChildAt: function(this: any, index: number) {
        return this.__children[index] ?? null;
      },
      getChildByName: function(this: any, name: string) {
        return this.__children.find((child: any) => child.name === name) ?? null;
      },
      getChildIndex: function(this: any, child: any) {
        const index = this.__children.indexOf(child);
        if (index < 0) throw new AS3RuntimeError("DisplayObjectContainer.getChildIndex", "Child is not attached");
        return index;
      },
      setChildIndex: function(this: any, child: any, index: number) {
        const current = this.getChildIndex(child);
        this.__children.splice(current, 1);
        this.__children.splice(index, 0, child);
      },
      swapChildren: function(this: any, first: any, second: any) {
        const a = this.getChildIndex(first);
        const b = this.getChildIndex(second);
        [this.__children[a], this.__children[b]] = [this.__children[b], this.__children[a]];
      },
      contains: function(this: any, child: any) {
        for (let current = child; current; current = current.parent) {
          if (current === this) return true;
        }
        return false;
      },
    },
    init(target) {
      Object.defineProperty(target, "__children", {
        value: Array.isArray(target.__children) ? target.__children : [],
        writable: true,
        enumerable: false,
        configurable: true,
      });
      target.mouseChildren = true;
    },
  },
  "flash.display.Graphics": {
    methods: {
      clear: function(this: any) {
        const state = graphicsState(this, "Graphics.clear");
        state.commands = [];
        state.segments = [];
        state.fill = null;
        state.stroke = null;
      },
      beginFill: function(this: any, color: number, alpha = 1) {
        graphicsState(this, "Graphics.beginFill").fill = {
          kind: "solid",
          color: Number(color) >>> 0,
          alpha: Number(alpha),
        };
      },
      endFill: function(this: any) {
        graphicsState(this, "Graphics.endFill").fill = null;
      },
      beginGradientFill: function(
        this: any,
        type: string = "linear",
        colors: any[] = [],
        alphas: any[] = [],
        ratios: any[] = [],
        matrix: any = null,
        spreadMethod: string = "pad",
        interpolationMethod: string = "rgb",
        focalPointRatio = 0,
      ) {
        void spreadMethod;
        void interpolationMethod;
        graphicsState(this, "Graphics.beginGradientFill").fill = {
          kind: "gradient",
          type: String(type),
          colors: Array.from(colors ?? [], Number),
          alphas: Array.from(alphas ?? [], Number),
          ratios: Array.from(ratios ?? [], Number),
          matrix: graphicsFillMatrixSnapshot(matrix),
          focal: Math.max(-1, Math.min(1, Number(focalPointRatio) || 0)),
        };
      },
      beginBitmapFill: function(
        this: any,
        bitmap: any,
        matrix: any = null,
        repeat = true,
        smooth = false,
      ) {
        graphicsState(this, "Graphics.beginBitmapFill").fill = {
          kind: "bitmap",
          bitmap,
          matrix: graphicsFillMatrixSnapshot(matrix),
          repeat: repeat !== false,
          smooth: smooth === true,
        };
      },
      lineStyle: function(this: any, thickness = 0, color = 0, alpha = 1) {
        const state = graphicsState(this, "Graphics.lineStyle");
        state.stroke = Number(thickness) > 0
          ? { thickness: Number(thickness), color: Number(color) >>> 0, alpha: Number(alpha) }
          : null;
      },
      moveTo: function(this: any, x: number, y: number) {
        const state = graphicsState(this, "Graphics.moveTo");
        finishGraphicsPath(state);
        state.startX = Number(x);
        state.startY = Number(y);
        state.segments = [];
      },
      lineTo: function(this: any, x: number, y: number) {
        const state = graphicsState(this, "Graphics.lineTo");
        state.segments.push({ kind: "line", x: Number(x), y: Number(y) });
      },
      curveTo: function(this: any, controlX: number, controlY: number, x: number, y: number) {
        const state = graphicsState(this, "Graphics.curveTo");
        state.segments.push({
          kind: "curve",
          cx: Number(controlX),
          cy: Number(controlY),
          x: Number(x),
          y: Number(y),
        });
      },
      drawRect: function(this: any, x: number, y: number, width: number, height: number) {
        const state = graphicsState(this, "Graphics.drawRect");
        finishGraphicsPath(state);
        state.commands.push({
          kind: "rect", x: Number(x), y: Number(y), width: Number(width), height: Number(height),
          fill: state.fill, stroke: state.stroke,
        });
      },
      drawRoundRect: function(this: any, x: number, y: number, width: number, height: number, ellipseWidth: number, ellipseHeight: number) {
        const state = graphicsState(this, "Graphics.drawRoundRect");
        finishGraphicsPath(state);
        state.commands.push({
          kind: "roundRect", x: Number(x), y: Number(y), width: Number(width), height: Number(height),
          ellipseWidth: Number(ellipseWidth), ellipseHeight: Number(ellipseHeight),
          fill: state.fill, stroke: state.stroke,
        });
      },
      drawCircle: function(this: any, x: number, y: number, radius: number) {
        const state = graphicsState(this, "Graphics.drawCircle");
        finishGraphicsPath(state);
        state.commands.push({
          kind: "circle", x: Number(x), y: Number(y), radius: Number(radius),
          fill: state.fill, stroke: state.stroke,
        });
      },
      drawEllipse: function(this: any, x: number, y: number, width: number, height: number) {
        const state = graphicsState(this, "Graphics.drawEllipse");
        finishGraphicsPath(state);
        state.commands.push({
          kind: "ellipse", x: Number(x), y: Number(y), width: Number(width), height: Number(height),
          fill: state.fill, stroke: state.stroke,
        });
      },
    },
    init(target) {
      graphicsStates.set(target, {
        commands: [],
        fill: null,
        stroke: null,
        startX: 0,
        startY: 0,
        segments: [],
      });
    },
  },
  "flash.display.Sprite": {
    fields: {
      graphics: { type: "flash.display.Graphics" },
      buttonMode: { type: "Boolean" },
      useHandCursor: { type: "Boolean" },
    },
    methods: {
      startDrag: function() {
        throw new AS3RuntimeError("Sprite.startDrag");
      },
      stopDrag: function() {
        throw new AS3RuntimeError("Sprite.stopDrag");
      },
    },
    init(target) {
      target.graphics = runtimeNew("flash.display.Graphics");
      target.buttonMode = false;
      target.useHandCursor = true;
    },
  },
  "flash.display.MovieClip": {
    fields: {
      currentFrame: { type: "int" },
      totalFrames: { type: "int" },
      framesLoaded: { type: "int" },
      currentLabel: { type: "String" },
      currentFrameLabel: { type: "String" },
    },
    accessors: {
      isPlaying: {
        get: function(this: any) {
          return this.__playing === true;
        },
      },
      currentLabels: {
        get: function() {
          return [];
        },
      },
    },
    methods: {
      play: function(this: any) {
        this.__playing = true;
      },
      stop: function(this: any) {
        this.__playing = false;
      },
      gotoAndPlay: function(this: any, frame: number) {
        this.currentFrame = movieFrame(this, frame);
        this.__playing = true;
      },
      gotoAndStop: function(this: any, frame: number) {
        this.currentFrame = movieFrame(this, frame);
        this.__playing = false;
      },
      nextFrame: function(this: any) {
        this.gotoAndStop(this.currentFrame + 1);
      },
      prevFrame: function(this: any) {
        this.gotoAndStop(this.currentFrame - 1);
      },
    },
    init(target) {
      target.currentFrame = 1;
      target.totalFrames = 1;
      target.framesLoaded = 1;
      target.currentLabel = null;
      target.currentFrameLabel = null;
      target.__playing = true;
    },
  },
  "flash.display.Shape": {
    init(target) {
      target.graphics = runtimeNew("flash.display.Graphics");
    },
  },
  "flash.display.BitmapData": {
    fields: {
      width: { type: "int" },
      height: { type: "int" },
      transparent: { type: "Boolean" },
      rect: { type: "flash.geom.Rectangle" },
    },
    methods: {
      getPixel: function(this: any, x: number, y: number) {
        const state = bitmapDataState(this, "BitmapData.getPixel");
        if (x < 0 || y < 0 || x >= state.width || y >= state.height) return 0;
        return state.pixels[y * state.width + x]! & 0xffffff;
      },
      getPixel32: function(this: any, x: number, y: number) {
        const state = bitmapDataState(this, "BitmapData.getPixel32");
        if (x < 0 || y < 0 || x >= state.width || y >= state.height) return 0;
        return state.pixels[y * state.width + x]! >>> 0;
      },
      setPixel: function(this: any, x: number, y: number, color: number) {
        const state = bitmapDataState(this, "BitmapData.setPixel");
        if (x < 0 || y < 0 || x >= state.width || y >= state.height) return;
        state.pixels[y * state.width + x] = (state.pixels[y * state.width + x]! & 0xff000000) | (Number(color) & 0xffffff);
      },
      setPixel32: function(this: any, x: number, y: number, color: number) {
        const state = bitmapDataState(this, "BitmapData.setPixel32");
        if (x < 0 || y < 0 || x >= state.width || y >= state.height) return;
        state.pixels[y * state.width + x] = Number(color) >>> 0;
      },
      fillRect: function(this: any, rect: any, color: number) {
        const state = bitmapDataState(this, "BitmapData.fillRect");
        const left = Math.max(0, Math.floor(Number(rect?.x ?? 0)));
        const top = Math.max(0, Math.floor(Number(rect?.y ?? 0)));
        const right = Math.min(state.width, Math.ceil(Number(rect?.x ?? 0) + Number(rect?.width ?? 0)));
        const bottom = Math.min(state.height, Math.ceil(Number(rect?.y ?? 0) + Number(rect?.height ?? 0)));
        const value = Number(color) >>> 0;
        for (let y = top; y < bottom; y += 1) {
          for (let x = left; x < right; x += 1) state.pixels[y * state.width + x] = value;
        }
      },
      lock: function(this: any) {
        // Flash defers stage updates between lock() and unlock(). Pixels are read
        // synchronously when the stage draws them, so there is no staging state to hold.
        bitmapDataState(this, "BitmapData.lock");
      },
      unlock: function(this: any) {
        bitmapDataState(this, "BitmapData.unlock");
      },
      draw: function(
        this: any,
        source: any,
        matrix: any = null,
        colorTransform: any = null,
        blendMode: any = null,
        clipRect: any = null,
        smoothing: boolean = false,
      ) {
        const target = bitmapDataState(this, "BitmapData.draw");
        // Flash blend modes composite the blended colour over the backdrop with source-over alpha.
        const mode = typeof blendMode === "string" && blendMode.length > 0 ? blendMode : "normal";
        const transform = colorTransformValues(colorTransform);
        const left = clipRect ? Math.max(0, Math.floor(Number(clipRect.x ?? 0))) : 0;
        const top = clipRect ? Math.max(0, Math.floor(Number(clipRect.y ?? 0))) : 0;
        const right = clipRect
          ? Math.min(target.width, Math.ceil(Number(clipRect.x ?? 0) + Number(clipRect.width ?? 0)))
          : target.width;
        const bottom = clipRect
          ? Math.min(target.height, Math.ceil(Number(clipRect.y ?? 0) + Number(clipRect.height ?? 0)))
          : target.height;
        if (bitmapDataStates.has(source)) {
          const origin = bitmapDataState(source, "BitmapData.draw");
          const a = Number(matrix?.a ?? 1);
          const b = Number(matrix?.b ?? 0);
          const c = Number(matrix?.c ?? 0);
          const d = Number(matrix?.d ?? 1);
          const determinant = a * d - b * c;
          if (determinant === 0) {
            throw new AS3RuntimeError("BitmapData.draw", "The draw matrix is not invertible");
          }
          const tx = Number(matrix?.tx ?? 0);
          const ty = Number(matrix?.ty ?? 0);
          for (let y = top; y < bottom; y += 1) {
            const dy = y - ty;
            for (let x = left; x < right; x += 1) {
              const dx = x - tx;
              const sourceX = Math.floor((d * dx - c * dy) / determinant);
              const sourceY = Math.floor((a * dy - b * dx) / determinant);
              if (
                sourceX < 0 || sourceY < 0 ||
                sourceX >= origin.width || sourceY >= origin.height
              ) {
                continue;
              }
              const pixel = origin.pixels[sourceY * origin.width + sourceX]!;
              compositePixel(target, y * target.width + x, pixel, transform, mode);
            }
          }
          return;
        }
        // A display object draws its content at the origin: draw() ignores its own transform.
        const rasterized = rasterizeDisplayObject(source, target.width, target.height, matrix, smoothing);
        for (let y = top; y < bottom; y += 1) {
          for (let x = left; x < right; x += 1) {
            compositePixel(target, y * target.width + x, rasterized[y * target.width + x]!, transform, mode);
          }
        }
      },
      copyPixels: function(
        this: any,
        source: any,
        sourceRect: any,
        destPoint: any,
        alphaBitmapData: any = null,
        alphaPoint: any = null,
        mergeAlpha: boolean = false,
      ) {
        const target = bitmapDataState(this, "BitmapData.copyPixels");
        const origin = bitmapDataState(source, "BitmapData.copyPixels");
        const mask = alphaBitmapData ? bitmapDataState(alphaBitmapData, "BitmapData.copyPixels") : null;
        const sx = Math.floor(Number(sourceRect?.x ?? 0));
        const sy = Math.floor(Number(sourceRect?.y ?? 0));
        const width = Math.min(Math.floor(Number(sourceRect?.width ?? origin.width)), origin.width - sx);
        const height = Math.min(Math.floor(Number(sourceRect?.height ?? origin.height)), origin.height - sy);
        const dx = Math.floor(Number(destPoint?.x ?? 0));
        const dy = Math.floor(Number(destPoint?.y ?? 0));
        const maskX = Math.floor(Number(alphaPoint?.x ?? 0));
        const maskY = Math.floor(Number(alphaPoint?.y ?? 0));
        // Flash replaces pixels by default. `mergeAlpha` (and copying a transparent bitmap onto
        // an opaque one) composites instead, so the transparent parts of a skin piece keep the
        // pixels already beneath them. An alpha bitmap scales the source's alpha channel.
        const composite = mergeAlpha || (origin.transparent && !target.transparent);
        for (let y = 0; y < height; y += 1) {
          for (let x = 0; x < width; x += 1) {
            const tx = dx + x;
            const ty = dy + y;
            if (tx < 0 || ty < 0 || tx >= target.width || ty >= target.height) continue;
            const pixel = origin.pixels[(sy + y) * origin.width + (sx + x)]!;
            let alpha = (pixel >>> 24) & 0xff;
            if (mask) {
              const mx = maskX + x;
              const my = maskY + y;
              if (mx < 0 || my < 0 || mx >= mask.width || my >= mask.height) continue;
              const maskAlpha = (mask.pixels[my * mask.width + mx]! >>> 24) & 0xff;
              alpha = Math.round((alpha * maskAlpha) / 255);
            }
            const index = ty * target.width + tx;
            if (!composite) {
              target.pixels[index] = ((alpha << 24) | (pixel & 0xffffff)) >>> 0;
              continue;
            }
            const sourceAlpha = alpha / 255;
            if (sourceAlpha <= 0) continue;
            const destination = target.pixels[index]!;
            const destinationAlpha = ((destination >>> 24) & 0xff) / 255;
            const outAlpha = sourceAlpha + destinationAlpha * (1 - sourceAlpha);
            const over = (src: number, dst: number): number =>
              Math.round((src * sourceAlpha + dst * destinationAlpha * (1 - sourceAlpha)) / outAlpha);
            const red = over((pixel >>> 16) & 0xff, (destination >>> 16) & 0xff);
            const green = over((pixel >>> 8) & 0xff, (destination >>> 8) & 0xff);
            const blue = over(pixel & 0xff, destination & 0xff);
            target.pixels[index] = ((Math.round(outAlpha * 255) << 24) | (red << 16) | (green << 8) | blue) >>> 0;
          }
        }
      },
      hitTest: function(
        this: any,
        firstPoint: any,
        firstAlphaThreshold: any = 0,
        secondObject: any = null,
        secondPoint: any = null,
        secondAlphaThreshold: any = 1,
      ) {
        const state = bitmapDataState(this, "BitmapData.hitTest");
        const threshold = Number(firstAlphaThreshold) || 0;
        const firstX = Math.floor(Number(firstPoint?.x ?? 0));
        const firstY = Math.floor(Number(firstPoint?.y ?? 0));
        if (secondObject && bitmapDataStates.has(secondObject)) {
          const other = bitmapDataState(secondObject, "BitmapData.hitTest");
          const secondX = Math.floor(Number(secondPoint?.x ?? 0));
          const secondY = Math.floor(Number(secondPoint?.y ?? 0));
          const secondThreshold = Number(secondAlphaThreshold) || 0;
          const left = Math.max(firstX, secondX);
          const top = Math.max(firstY, secondY);
          const right = Math.min(firstX + state.width, secondX + other.width);
          const bottom = Math.min(firstY + state.height, secondY + other.height);
          for (let y = top; y < bottom; y += 1) {
            for (let x = left; x < right; x += 1) {
              const a = (state.pixels[(y - firstY) * state.width + (x - firstX)]! >>> 24) & 0xff;
              const b = (other.pixels[(y - secondY) * other.width + (x - secondX)]! >>> 24) & 0xff;
              if (a >= threshold && b >= secondThreshold) return true;
            }
          }
          return false;
        }
        // Flash accepts a Point as the second object: test that pixel of this bitmap.
        if (secondObject && typeof secondObject === "object" && "x" in secondObject && "y" in secondObject) {
          const x = firstX + Math.floor(Number(secondObject.x ?? 0));
          const y = firstY + Math.floor(Number(secondObject.y ?? 0));
          if (x < 0 || y < 0 || x >= state.width || y >= state.height) return false;
          return ((state.pixels[y * state.width + x]! >>> 24) & 0xff) >= threshold;
        }
        throw new AS3RuntimeError(
          "BitmapData.hitTest",
          "Only a Point or another BitmapData can be hit-tested",
        );
      },
      copyChannel: function(
        this: any,
        source: any,
        sourceRect: any,
        destPoint: any,
        sourceChannel: number,
        destChannel: number,
      ) {
        const target = bitmapDataState(this, "BitmapData.copyChannel");
        const origin = bitmapDataState(source, "BitmapData.copyChannel");
        const sx = Math.floor(Number(sourceRect?.x ?? 0));
        const sy = Math.floor(Number(sourceRect?.y ?? 0));
        const width = Math.min(Math.floor(Number(sourceRect?.width ?? origin.width)), origin.width - sx);
        const height = Math.min(Math.floor(Number(sourceRect?.height ?? origin.height)), origin.height - sy);
        const dx = Math.floor(Number(destPoint?.x ?? 0));
        const dy = Math.floor(Number(destPoint?.y ?? 0));
        // BitmapDataChannel: RED=1, GREEN=2, BLUE=4, ALPHA=8. Only channels selected on
        // both sides move, which is how Flash copies a RED|GREEN pair as red-to-red and green-to-green.
        // A source channel can land on a different destination channel (ALPHA -> RED is
        // how the room builds its plane masks), so selected channels pair up in order.
        const shiftFor = (bit: number): number => (bit === 3 ? 24 : 16 - bit * 8);
        const sourceMask = Number(sourceChannel) & 0xf;
        const destMask = Number(destChannel) & 0xf;
        const sourceShifts: number[] = [];
        const destShifts: number[] = [];
        for (let bit = 0; bit < 4; bit += 1) {
          if ((sourceMask & (1 << bit)) !== 0) sourceShifts.push(shiftFor(bit));
          if ((destMask & (1 << bit)) !== 0) destShifts.push(shiftFor(bit));
        }
        const pairs = Math.min(sourceShifts.length, destShifts.length);
        if (pairs === 0) return;
        for (let y = 0; y < height; y += 1) {
          const ty = dy + y;
          if (ty < 0 || ty >= target.height) continue;
          for (let x = 0; x < width; x += 1) {
            const tx = dx + x;
            if (tx < 0 || tx >= target.width) continue;
            const pixel = origin.pixels[(sy + y) * origin.width + (sx + x)]!;
            const index = ty * target.width + tx;
            let value = target.pixels[index]!;
            for (let pair = 0; pair < pairs; pair += 1) {
              const sourceShift = sourceShifts[pair]!;
              const destShift = destShifts[pair]!;
              value = (value & ~(0xff << destShift)) | (((pixel >>> sourceShift) & 0xff) << destShift);
            }
            target.pixels[index] = value >>> 0;
          }
        }
      },
      applyFilter: function(this: any, source: any, sourceRect: any, destPoint: any, filter: any) {
        const target = bitmapDataState(this, "BitmapData.applyFilter");
        const origin = source && bitmapDataStates.has(source)
          ? bitmapDataState(source, "BitmapData.applyFilter")
          : target;
        const sx = Math.max(0, Math.floor(Number(sourceRect?.x ?? 0)));
        const sy = Math.max(0, Math.floor(Number(sourceRect?.y ?? 0)));
        const width = Math.min(Math.floor(Number(sourceRect?.width ?? origin.width)), origin.width - sx);
        const height = Math.min(Math.floor(Number(sourceRect?.height ?? origin.height)), origin.height - sy);
        const dx = Math.floor(Number(destPoint?.x ?? 0));
        const dy = Math.floor(Number(destPoint?.y ?? 0));
        if (width <= 0 || height <= 0) return;
        // applyFilter reads the source region before writing, so self-filtering needs a copy.
        const region = new Uint32Array(width * height);
        for (let y = 0; y < height; y += 1) {
          for (let x = 0; x < width; x += 1) {
            region[y * width + x] = origin.pixels[(sy + y) * origin.width + (sx + x)]!;
          }
        }
        const kind = filter?.constructor?.$fqcn ?? "";
        let result: Uint32Array;
        switch (kind) {
          case "flash.filters.ColorMatrixFilter": {
            const matrix = Array.isArray(filter?.matrix) ? filter.matrix.map(Number) : [];
            if (matrix.length < 20) {
              throw new AS3RuntimeError("BitmapData.applyFilter", "A ColorMatrixFilter needs a 4x5 matrix");
            }
            result = colorMatrixPixels(region, matrix);
            break;
          }
          case "flash.filters.BlurFilter":
            result = blurPixels(region, width, height, filter);
            break;
          case "flash.filters.GlowFilter":
            result = shadowPixels(region, width, height, filter, 0, 0);
            break;
          case "flash.filters.DropShadowFilter": {
            const angle = (Number(filter?.angle ?? 45) * Math.PI) / 180;
            const distance = Number(filter?.distance ?? 4);
            result = shadowPixels(region, width, height, filter, Math.cos(angle) * distance, Math.sin(angle) * distance);
            break;
          }
          case "flash.filters.ConvolutionFilter":
            result = convolutionPixels(region, width, height, filter);
            break;
          case "flash.filters.DisplacementMapFilter":
            result = displacementPixels(region, width, height, filter);
            break;
          default:
            throw new AS3RuntimeError(
              "BitmapData.applyFilter",
              `Bitmap filters of type ${kind || "unknown"} are not implemented; supported: ColorMatrixFilter, ` +
                "BlurFilter, GlowFilter, DropShadowFilter, ConvolutionFilter, DisplacementMapFilter",
            );
        }
        for (let y = 0; y < height; y += 1) {
          const targetY = dy + y;
          if (targetY < 0 || targetY >= target.height) continue;
          for (let x = 0; x < width; x += 1) {
            const targetX = dx + x;
            if (targetX < 0 || targetX >= target.width) continue;
            target.pixels[targetY * target.width + targetX] = result[y * width + x]!;
          }
        }
      },
      clone: function(this: any) {
        const state = bitmapDataState(this, "BitmapData.clone");
        const copy = runtimeNew("flash.display.BitmapData", state.width, state.height, state.transparent);
        bitmapDataState(copy, "BitmapData.clone").pixels.set(state.pixels);
        return copy;
      },
      colorTransform: function(this: any, rect: any, colorTransform: any) {
        const state = bitmapDataState(this, "BitmapData.colorTransform");
        const values = colorTransformValues(colorTransform);
        const left = Math.max(0, Math.floor(Number(rect?.x ?? 0)));
        const top = Math.max(0, Math.floor(Number(rect?.y ?? 0)));
        const right = Math.min(state.width, Math.ceil(Number(rect?.x ?? 0) + Number(rect?.width ?? 0)));
        const bottom = Math.min(state.height, Math.ceil(Number(rect?.y ?? 0) + Number(rect?.height ?? 0)));
        const clamp = (value: number) => (value < 0 ? 0 : value > 255 ? 255 : Math.round(value));
        for (let y = top; y < bottom; y += 1) {
          for (let x = left; x < right; x += 1) {
            const index = y * state.width + x;
            const pixel = state.pixels[index]!;
            const alpha = clamp(((pixel >>> 24) & 0xff) * values.alphaMultiplier + values.alphaOffset);
            const red = clamp(((pixel >>> 16) & 0xff) * values.redMultiplier + values.redOffset);
            const green = clamp(((pixel >>> 8) & 0xff) * values.greenMultiplier + values.greenOffset);
            const blue = clamp((pixel & 0xff) * values.blueMultiplier + values.blueOffset);
            state.pixels[index] = (((state.transparent ? alpha : 255) << 24) | (red << 16) | (green << 8) | blue) >>> 0;
          }
        }
      },
      dispose: function(this: any) {
        const state = bitmapDataState(this, "BitmapData.dispose");
        state.pixels.fill(0);
        state.width = 0;
        state.height = 0;
      },
    },
    init(target, args) {
      const width = Math.max(0, Number(args[0] ?? 0) | 0);
      const height = Math.max(0, Number(args[1] ?? 0) | 0);
      const transparent = Boolean(args[2] ?? true);
      const pixels = new Uint32Array(width * height);
      pixels.fill(Number(args[3] ?? (transparent ? 0 : 0xff000000)) >>> 0);
      target.width = width;
      target.height = height;
      target.transparent = transparent;
      target.rect = runtimeNew("flash.geom.Rectangle", 0, 0, width, height);
      bitmapDataStates.set(target, { width, height, transparent, pixels, version: 0 });
    },
  },
  "flash.display.Bitmap": {
    fields: {
      bitmapData: { type: "flash.display.BitmapData" },
      pixelSnapping: { type: "String" },
      smoothing: { type: "Boolean" },
    },
    init(target, args) {
      target.bitmapData = args[0] ?? null;
      target.pixelSnapping = "auto";
      target.smoothing = false;
    },
  },
  "flash.display.LoaderInfo": {
    fields: {
      parameters: { type: "Object" },
      loaderURL: { type: "String" },
      url: { type: "String" },
      bytesLoaded: { type: "uint" },
      bytesTotal: { type: "uint" },
      content: { type: "flash.display.DisplayObject" },
      loader: { type: "flash.display.Loader" },
      applicationDomain: { type: "flash.system.ApplicationDomain" },
      uncaughtErrorEvents: { type: "Object" },
      sharedEvents: { type: "flash.events.EventDispatcher" },
    },
    init(target) {
      ensureExternalVariables();
      target.parameters = externalVariables;
      target.loaderURL = externalUrl;
      target.url = externalUrl;
      target.bytesLoaded = 0;
      target.bytesTotal = 0;
      target.content = null;
      target.loader = null;
      target.applicationDomain = runtimeNew("flash.system.ApplicationDomain");
      target.uncaughtErrorEvents = runtimeNew("flash.events.EventDispatcher");
      target.sharedEvents = runtimeNew("flash.events.EventDispatcher");
    },
  },
  "flash.display.BlendMode": {
    staticValues: {
      ADD: "add",
      ALPHA: "alpha",
      DARKEN: "darken",
      DIFFERENCE: "difference",
      ERASE: "erase",
      HARDLIGHT: "hardlight",
      INVERT: "invert",
      LAYER: "layer",
      LIGHTEN: "lighten",
      MULTIPLY: "multiply",
      NORMAL: "normal",
      OVERLAY: "overlay",
      SCREEN: "screen",
      SHADER: "shader",
      SUBTRACT: "subtract",
    },
  },
  "flash.display.StageDisplayState": {
    staticValues: { FULL_SCREEN: "fullScreen", NORMAL: "normal" },
  },
  "flash.display.StageScaleMode": {
    staticValues: { EXACT_FIT: "exactFit", NO_BORDER: "noBorder", NO_SCALE: "noScale", SHOW_ALL: "showAll" },
  },
  "flash.display.StageQuality": {
    staticValues: { BEST: "best", HIGH: "high", LOW: "low", MEDIUM: "medium" },
  },
  "flash.display.StageAlign": {
    staticValues: {
      BOTTOM: "B",
      BOTTOM_LEFT: "BL",
      BOTTOM_RIGHT: "BR",
      LEFT: "L",
      RIGHT: "R",
      TOP: "T",
      TOP_LEFT: "TL",
      TOP_RIGHT: "TR",
    },
  },
  "flash.display.Stage": {
    fields: {
      stageWidth: { type: "int" },
      stageHeight: { type: "int" },
      frameRate: { type: "Number" },
      quality: { type: "String" },
    },
    accessors: {
      // Ruffle recomputes the matrices on `set_scale_mode`/`set_align`, so assigning either one
      // can resize a NO_SCALE stage and dispatch resize right away.
      scaleMode: {
        get: function(this: any) {
          return this.__scaleMode ?? "showAll";
        },
        set: function(this: any, value: string) {
          this.__scaleMode = String(value);
          stageBuildMatrices(this);
        },
      },
      align: {
        get: function(this: any) {
          return this.__align ?? "";
        },
        set: function(this: any, value: string) {
          this.__align = String(value);
          stageBuildMatrices(this);
        },
      },
    },
    init(target) {
      target.stageWidth = 0;
      target.stageHeight = 0;
      target.frameRate = 24;
      target.align = "";
      target.scaleMode = "showAll";
      target.quality = "high";
      target.stage = target;
      target.root = target;
    },
  },
  "flash.display.Loader": {
    fields: {
      content: { type: "flash.display.DisplayObject" },
      contentLoaderInfo: { type: "flash.display.LoaderInfo" },
    },
    methods: {
      load: function(this: any, request: any, context?: any) {
        swfLoad(this, request, context);
      },
      loadBytes: function(this: any, bytes: any, context?: any) {
        swfLoadBytes(this, bytes, context);
      },
      close: function(this: any) {
        this.__swfAbort?.abort?.();
        this.__swfAbort = null;
      },
      unload: function(this: any) {
        this.__swfAbort?.abort?.();
        this.__swfAbort = null;
        if (this.contentLoaderInfo) this.contentLoaderInfo.content = null;
        this.content = null;
      },
    },
    init(target) {
      target.content = null;
      target.contentLoaderInfo = runtimeNew("flash.display.LoaderInfo");
      target.contentLoaderInfo.loader = target;
    },
  },
  "flash.ui.Keyboard": {
    staticValues: {
      BACKSPACE: 8,
      TAB: 9,
      ENTER: 13,
      SHIFT: 16,
      CONTROL: 17,
      ESCAPE: 27,
      SPACE: 32,
      LEFT: 37,
      UP: 38,
      RIGHT: 39,
      DOWN: 40,
      NUMPAD_ADD: 107,
      NUMPAD_SUBTRACT: 109,
    },
  },
  "flash.utils.Endian": {
    staticValues: { BIG_ENDIAN: "bigEndian", LITTLE_ENDIAN: "littleEndian" },
  },
  "flash.utils.CompressionAlgorithm": {
    staticValues: { DEFLATE: "deflate", LZMA: "lzma", ZLIB: "zlib" },
  },
  "flash.display.BitmapDataChannel": {
    staticValues: { ALPHA: 8, BLUE: 4, GREEN: 2, RED: 1 },
  },
  "flash.display.GradientType": {
    staticValues: { LINEAR: "linear", RADIAL: "radial" },
  },
  "flash.display.InterpolationMethod": {
    staticValues: { LINEAR_RGB: "linearRGB", RGB: "rgb" },
  },
  "flash.display.PixelSnapping": {
    staticValues: { ALWAYS: "always", AUTO: "auto", NEVER: "never" },
  },
  "flash.display.SpreadMethod": {
    staticValues: { PAD: "pad", REFLECT: "reflect", REPEAT: "repeat" },
  },
  "flash.filters.BitmapFilterQuality": {
    staticValues: { HIGH: 3, LOW: 1, MEDIUM: 2 },
  },
  "flash.text.TextFormatAlign": {
    staticValues: {
      CENTER: "center",
      END: "end",
      JUSTIFY: "justify",
      LEFT: "left",
      RIGHT: "right",
      START: "start",
    },
  },
  "flash.text.AntiAliasType": {
    staticValues: { ADVANCED: "advanced", NORMAL: "normal" },
  },
  "flash.text.FontStyle": {
    staticValues: { REGULAR: "regular", BOLD: "bold", ITALIC: "italic", BOLD_ITALIC: "boldItalic" },
  },
  "flash.text.FontType": {
    staticValues: { EMBEDDED: "embedded", DEVICE: "device" },
  },
  "flash.text.TextLineMetrics": {
    fields: {
      x: { type: "Number" },
      width: { type: "Number" },
      height: { type: "Number" },
      ascent: { type: "Number" },
      descent: { type: "Number" },
      leading: { type: "Number" },
    },
    init(target, args) {
      target.x = Number(args[0] ?? 0);
      target.width = Number(args[1] ?? 0);
      target.height = Number(args[2] ?? 0);
      target.ascent = Number(args[3] ?? 0);
      target.descent = Number(args[4] ?? 0);
      target.leading = Number(args[5] ?? 0);
    },
  },
  "flash.text.TextFieldType": {
    staticValues: { DYNAMIC: "dynamic", INPUT: "input" },
  },
  "flash.text.TextFieldAutoSize": {
    staticValues: { CENTER: "center", LEFT: "left", NONE: "none", RIGHT: "right" },
  },
  "flash.text.GridFitType": {
    staticValues: { NONE: "none", PIXEL: "pixel", SUBPIXEL: "subpixel" },
  },
  "flash.text.StyleSheet": {
    accessors: {
      styleNames: {
        get: function(this: any) {
          return Object.keys(this.__styles ?? {});
        },
      },
    },
    methods: {
      clear: function(this: any) {
        this.__styles = {};
      },
      setStyle: function(this: any, name: any, style: any) {
        if (!this.__styles) this.__styles = {};
        this.__styles[String(name)] = style ?? {};
      },
      getStyle: function(this: any, name: any) {
        return (this.__styles ?? {})[String(name)] ?? null;
      },
      parseCSS: function(this: any, css: any) {
        const text = String(css ?? "").replace(/\/\*[\s\S]*?\*\//g, "");
        if (!this.__styles) this.__styles = {};
        const rule = /([^{}]+)\{([^{}]*)\}/g;
        let match = rule.exec(text);
        while (match) {
          const declarations: Record<string, string> = {};
          for (const part of match[2].split(";")) {
            const index = part.indexOf(":");
            if (index <= 0) continue;
            const property = part.slice(0, index).trim();
            if (property.length > 0) declarations[property] = part.slice(index + 1).trim();
          }
          for (const selector of match[1].split(",")) {
            const name = selector.trim();
            if (name.length > 0) this.__styles[name] = declarations;
          }
          match = rule.exec(text);
        }
      },
      transform: function(this: any, style: any) {
        return style ?? {};
      },
    },
    init(target) {
      target.__styles = {};
    },
  },
  "flash.text.TextFormat": {
    fields: {
      font: { type: "String" },
      size: { type: "Object" },
      color: { type: "Object" },
      bold: { type: "Object" },
      italic: { type: "Object" },
      underline: { type: "Object" },
      align: { type: "String" },
      leftMargin: { type: "Object" },
      rightMargin: { type: "Object" },
      indent: { type: "Object" },
      leading: { type: "Object" },
      kerning: { type: "Boolean" },
    },
    methods: {
      clone: function(this: any) {
        const copy = runtimeNew("flash.text.TextFormat");
        Object.assign(copy, this);
        return copy;
      },
    },
    init(target, args) {
      target.font = args[0] === undefined ? "Times New Roman" : String(args[0]);
      target.size = args[1] === undefined ? 12 : Number(args[1]);
      target.color = args[2] === undefined ? 0 : Number(args[2]) >>> 0;
      target.bold = Boolean(args[3] ?? false);
      target.italic = Boolean(args[4] ?? false);
      target.underline = Boolean(args[5] ?? false);
      target.align = "left";
      target.leftMargin = 0;
      target.rightMargin = 0;
      target.indent = 0;
      target.leading = 0;
      target.kerning = false;
    },
  },
  "flash.display.Shader": {
    fields: { byteCode: { type: "ByteArray" } },
    accessors: {
      data: {
        get: function(this: any) {
          return this.__data ?? null;
        },
        set: function(this: any, value: any) {
          this.__data = value;
        },
      },
      precisionHint: {
        get: function(this: any) {
          return this.__precisionHint ?? "full";
        },
        set: function(this: any, value: any) {
          this.__precisionHint = value;
        },
      },
    },
    init(target, args) {
      target.byteCode = args[0] ?? null;
      target.__data = null;
      target.__precisionHint = "full";
    },
  },
  "flash.filters.ShaderFilter": {
    fields: { shader: { type: "flash.display.Shader" } },
    init(target, args) {
      target.shader = args[0] ?? null;
    },
  },
  "flash.filters.BitmapFilter": {},
  "flash.filters.DropShadowFilter": {
    fields: {
      alpha: { type: "Number" },
      angle: { type: "Number" },
      blurX: { type: "Number" },
      blurY: { type: "Number" },
      color: { type: "uint" },
      distance: { type: "Number" },
      hideObject: { type: "Boolean" },
      inner: { type: "Boolean" },
      knockout: { type: "Boolean" },
      quality: { type: "int" },
      strength: { type: "Number" },
    },
    methods: {
      clone: function(this: any) {
        const copy = runtimeNew("flash.filters.DropShadowFilter");
        Object.assign(copy, this);
        return copy;
      },
    },
    init(target, args) {
      target.distance = args[0] === undefined ? 4 : Number(args[0]);
      target.angle = args[1] === undefined ? 45 : Number(args[1]);
      target.color = args[2] === undefined ? 0 : Number(args[2]) >>> 0;
      target.alpha = args[3] === undefined ? 1 : Number(args[3]);
      target.blurX = args[4] === undefined ? 4 : Number(args[4]);
      target.blurY = args[5] === undefined ? 4 : Number(args[5]);
      target.strength = args[6] === undefined ? 1 : Number(args[6]);
      target.quality = args[7] === undefined ? 1 : Number(args[7]) | 0;
      target.inner = Boolean(args[8] ?? false);
      target.knockout = Boolean(args[9] ?? false);
      target.hideObject = Boolean(args[10] ?? false);
    },
  },
  "flash.filters.BlurFilter": {
    fields: {
      blurX: { type: "Number" },
      blurY: { type: "Number" },
      quality: { type: "int" },
    },
    methods: {
      clone: function(this: any) {
        const copy = runtimeNew("flash.filters.BlurFilter");
        Object.assign(copy, this);
        return copy;
      },
    },
    init(target, args) {
      target.blurX = args[0] === undefined ? 4 : Number(args[0]);
      target.blurY = args[1] === undefined ? 4 : Number(args[1]);
      target.quality = args[2] === undefined ? 1 : Number(args[2]) | 0;
    },
  },
  "flash.filters.GlowFilter": {
    fields: {
      alpha: { type: "Number" },
      blurX: { type: "Number" },
      blurY: { type: "Number" },
      color: { type: "uint" },
      inner: { type: "Boolean" },
      knockout: { type: "Boolean" },
      quality: { type: "int" },
      strength: { type: "Number" },
    },
    methods: {
      clone: function(this: any) {
        const copy = runtimeNew("flash.filters.GlowFilter");
        Object.assign(copy, this);
        return copy;
      },
    },
    init(target, args) {
      target.color = args[0] === undefined ? 0xff0000 : Number(args[0]) >>> 0;
      target.alpha = args[1] === undefined ? 1 : Number(args[1]);
      target.blurX = args[2] === undefined ? 6 : Number(args[2]);
      target.blurY = args[3] === undefined ? 6 : Number(args[3]);
      target.strength = args[4] === undefined ? 2 : Number(args[4]);
      target.quality = args[5] === undefined ? 1 : Number(args[5]) | 0;
      target.inner = Boolean(args[6] ?? false);
      target.knockout = Boolean(args[7] ?? false);
    },
  },
  "flash.filters.ConvolutionFilter": {
    fields: {
      alpha: { type: "Number" },
      bias: { type: "Number" },
      clamp: { type: "Boolean" },
      color: { type: "uint" },
      divisor: { type: "Number" },
      matrix: { type: "Array" },
      matrixX: { type: "int" },
      matrixY: { type: "int" },
      preserveAlpha: { type: "Boolean" },
    },
    methods: {
      clone: function(this: any) {
        const copy = runtimeNew("flash.filters.ConvolutionFilter");
        Object.assign(copy, this);
        copy.matrix = Array.isArray(this.matrix) ? [...this.matrix] : [];
        return copy;
      },
    },
    init(target, args) {
      // Flash's order: matrixX, matrixY, matrix, divisor, bias, preserveAlpha, clamp, color, alpha.
      target.matrixX = args[0] === undefined ? 0 : Number(args[0]) | 0;
      target.matrixY = args[1] === undefined ? 0 : Number(args[1]) | 0;
      target.matrix = Array.isArray(args[2]) ? [...args[2]] : [];
      target.divisor = args[3] === undefined ? 1 : Number(args[3]);
      target.bias = args[4] === undefined ? 0 : Number(args[4]);
      target.preserveAlpha = args[5] === undefined ? true : Boolean(args[5]);
      target.clamp = args[6] === undefined ? true : Boolean(args[6]);
      target.color = args[7] === undefined ? 0 : Number(args[7]) >>> 0;
      target.alpha = args[8] === undefined ? 0 : Number(args[8]);
    },
  },
  "flash.filters.DisplacementMapFilter": {
    fields: {
      alpha: { type: "Number" },
      color: { type: "uint" },
      componentX: { type: "int" },
      componentY: { type: "int" },
      mapBitmap: { type: "flash.display.BitmapData" },
      mapPoint: { type: "flash.geom.Point" },
      mode: { type: "String" },
      scaleX: { type: "Number" },
      scaleY: { type: "Number" },
    },
    methods: {
      clone: function(this: any) {
        const copy = runtimeNew("flash.filters.DisplacementMapFilter");
        Object.assign(copy, this);
        return copy;
      },
    },
    init(target, args) {
      target.mapBitmap = args[0] ?? null;
      target.mapPoint = args[1] ?? null;
      target.componentX = args[2] === undefined ? 0 : Number(args[2]) | 0;
      target.componentY = args[3] === undefined ? 0 : Number(args[3]) | 0;
      target.scaleX = args[4] === undefined ? 0 : Number(args[4]);
      target.scaleY = args[5] === undefined ? 0 : Number(args[5]);
      target.mode = args[6] === undefined ? "wrap" : String(args[6]);
      target.color = args[7] === undefined ? 0 : Number(args[7]) >>> 0;
      target.alpha = args[8] === undefined ? 0 : Number(args[8]);
    },
  },
  "flash.text.TextField": {
    fields: {
      text: { type: "String" },
      defaultTextFormat: { type: "flash.text.TextFormat" },
      embedFonts: { type: "Boolean" },
      antiAliasType: { type: "String" },
      multiline: { type: "Boolean" },
      wordWrap: { type: "Boolean" },
      type: { type: "String" },
      selectable: { type: "Boolean" },
      autoSize: { type: "String" },
      sharpness: { type: "Number" },
      thickness: { type: "Number" },
      gridFitType: { type: "String" },
      background: { type: "Boolean" },
      backgroundColor: { type: "uint" },
      border: { type: "Boolean" },
      borderColor: { type: "uint" },
      maxChars: { type: "int" },
      restrict: { type: "String" },
      displayAsPassword: { type: "Boolean" },
      alwaysShowSelection: { type: "Boolean" },
      condenseWhite: { type: "Boolean" },
      mouseWheelEnabled: { type: "Boolean" },
    },
    accessors: {
      // Flash keeps the text color in the default format, so a later
      // `defaultTextFormat` assignment takes over the color as well.
      textColor: {
        get: function(this: any) {
          return Number(this.defaultTextFormat?.color ?? 0) >>> 0;
        },
        set: function(this: any, value: any) {
          if (this.defaultTextFormat) this.defaultTextFormat.color = Number(value) >>> 0;
        },
      },
      htmlText: {
        get: function(this: any) {
          return this.text;
        },
        set: function(this: any, value: any) {
          this.text = htmlToText(value);
        },
      },
      textWidth: {
        get: function(this: any) {
          return textFieldMetrics(this).width;
        },
      },
      textHeight: {
        get: function(this: any) {
          return textFieldMetrics(this).height;
        },
      },
      // Flash keeps a caret/selection range per text field; with no selection both indices
      // collapse to the caret position.
      selectionBeginIndex: {
        get: function(this: any) {
          return Math.min(Number(this.__selectionBegin ?? 0), String(this.text ?? "").length);
        },
        set: function(this: any, value: any) {
          const length = String(this.text ?? "").length;
          const begin = Math.max(0, Math.min(length, Math.trunc(Number(value) || 0)));
          this.__selectionBegin = begin;
          if (Number(this.__selectionEnd ?? 0) < begin) this.__selectionEnd = begin;
        },
      },
      selectionEndIndex: {
        get: function(this: any) {
          return Math.min(Number(this.__selectionEnd ?? 0), String(this.text ?? "").length);
        },
        set: function(this: any, value: any) {
          const length = String(this.text ?? "").length;
          const end = Math.max(0, Math.min(length, Math.trunc(Number(value) || 0)));
          this.__selectionEnd = end;
          if (Number(this.__selectionBegin ?? 0) > end) this.__selectionBegin = end;
        },
      },
    },
    methods: {
      setTextFormat: function(this: any, format: any) {
        this.__textFormat = format ?? this.defaultTextFormat;
        this.defaultTextFormat = this.__textFormat;
      },
      getTextFormat: function(this: any) {
        return this.__textFormat ?? this.defaultTextFormat;
      },
      appendText: function(this: any, value: any) {
        this.text = String(this.text ?? "") + String(value ?? "");
      },
      replaceText: function(this: any, begin: number, end: number, value: any) {
        const text = String(this.text ?? "");
        this.text = text.slice(0, begin) + String(value ?? "") + text.slice(end);
      },
      getLineText: function(this: any, lineIndex: number) {
        return String(this.text ?? "").split(/\r?\n/)[lineIndex] ?? "";
      },
      setSelection: function(this: any, begin: any, end: any) {
        const length = String(this.text ?? "").length;
        const first = Math.max(0, Math.min(length, Math.trunc(Number(begin) || 0)));
        const second = Math.max(0, Math.min(length, Math.trunc(Number(end) || 0)));
        this.__selectionBegin = Math.min(first, second);
        this.__selectionEnd = Math.max(first, second);
      },
      replaceSelectedText: function(this: any, value: any) {
        const text = String(this.text ?? "");
        const begin = Math.min(Number(this.__selectionBegin ?? 0), text.length);
        const end = Math.min(Number(this.__selectionEnd ?? 0), text.length);
        const replacement = String(value ?? "");
        this.text = text.slice(0, begin) + replacement + text.slice(end);
        this.__selectionBegin = begin + replacement.length;
        this.__selectionEnd = this.__selectionBegin;
      },
    },
    init(target) {
      target.text = "";
      target.htmlText = "";
      // Flash always has a default format: Times New Roman 12, black.
      target.defaultTextFormat = runtimeNew("flash.text.TextFormat");
      target.__textFormat = target.defaultTextFormat;
      target.textColor = 0;
      target.embedFonts = false;
      target.antiAliasType = "normal";
      target.multiline = false;
      target.wordWrap = false;
      target.type = "dynamic";
      target.selectable = true;
      target.autoSize = "none";
      target.sharpness = 0;
      target.thickness = 0;
      target.gridFitType = "pixel";
      target.background = false;
      target.backgroundColor = 0xffffff;
      target.border = false;
      target.borderColor = 0;
      target.maxChars = 0;
      target.restrict = null;
      target.displayAsPassword = false;
      target.alwaysShowSelection = false;
      target.condenseWhite = false;
      target.mouseWheelEnabled = true;
      target.__selectionBegin = 0;
      target.__selectionEnd = 0;
    },
  },
  "mx.core.SimpleApplication": {},
  "mx.core.BitmapAsset": {},
  "XML": {
    dynamic: true,
    methods: {
      child: function(this: any, name: any) {
        const state = xmlNodeState(this, "XML.child");
        return wrapXmlList(
          typeof name === "number" ? xmlIndexedChild(state, name) : xmlElementChildren(state, String(name)),
        );
      },
      children: function(this: any) {
        return wrapXmlList(xmlElementChildren(xmlNodeState(this, "XML.children"), "*"));
      },
      elements: function(this: any, name = "*") {
        return wrapXmlList(xmlElementChildren(xmlNodeState(this, "XML.elements"), String(name)));
      },
      attribute: function(this: any, name: string) {
        return wrapXmlList(xmlAttributeNodes(xmlNodeState(this, "XML.attribute"), String(name)));
      },
      attributes: function(this: any) {
        return wrapXmlList(xmlAttributeNodes(xmlNodeState(this, "XML.attributes"), "*"));
      },
      appendChild: function(this: any, child: any) {
        appendXmlChild(xmlNodeState(this, "XML.appendChild"), child, "XML.appendChild");
        return this;
      },
      copy: function(this: any) {
        return wrapXmlNode(cloneXmlNode(xmlNodeState(this, "XML.copy")));
      },
      text: function(this: any) {
        return xmlDirectText([xmlNodeState(this, "XML.text")]);
      },
      nodeKind: function(this: any) {
        return xmlNodeState(this, "XML.nodeKind").kind;
      },
      name: function(this: any) {
        return xmlNodeState(this, "XML.name").name;
      },
      localName: function(this: any) {
        const name = xmlNodeState(this, "XML.localName").name;
        return name.slice(name.lastIndexOf(":") + 1);
      },
      toString: function(this: any) {
        return xmlSimpleContentString([xmlNodeState(this, "XML.toString")]);
      },
      toXMLString: function(this: any) {
        return serializeXmlNode(xmlNodeState(this, "XML.toXMLString"));
      },
    },
    create(target, args) {
      const input = args[0];
      let node: XmlNode;
      if (isXmlNode(input)) node = input;
      else if (input === undefined || input === null) node = xmlText("");
      else if (isXmlObject(input)) node = xmlNodeState(input, "XML");
      else if (isXmlListObject(input)) {
        const nodes = xmlListState(input, "XML");
        if (nodes.length !== 1) throw new TypeError("An XMLList with exactly one node is required");
        node = nodes[0]!;
      } else node = parseXmlSource(String(input));
      const proxy = new Proxy(target, xmlProxyHandler());
      xmlNodes.set(proxy, node);
      return proxy;
    },
  },
  "XMLList": {
    dynamic: true,
    methods: {
      length: function(this: any) {
        return xmlListState(this, "XMLList.length").length;
      },
      child: function(this: any, name: any) {
        const nodes = xmlListState(this, "XMLList.child");
        if (typeof name !== "number") return wrapXmlList(xmlChildrenOf(nodes, String(name)));
        const indexed: XmlNode[] = [];
        for (const node of nodes) indexed.push(...xmlIndexedChild(node, name));
        return wrapXmlList(indexed);
      },
      children: function(this: any) {
        return wrapXmlList(xmlChildrenOf(xmlListState(this, "XMLList.children"), "*"));
      },
      elements: function(this: any, name = "*") {
        return wrapXmlList(xmlChildrenOf(xmlListState(this, "XMLList.elements"), String(name)));
      },
      attribute: function(this: any, name: string) {
        const nodes = xmlListState(this, "XMLList.attribute");
        return wrapXmlList(nodes.flatMap((node) => xmlAttributeNodes(node, String(name))));
      },
      attributes: function(this: any) {
        const nodes = xmlListState(this, "XMLList.attributes");
        return wrapXmlList(nodes.flatMap((node) => xmlAttributeNodes(node, "*")));
      },
      appendChild: function(this: any, child: any) {
        for (const node of xmlListState(this, "XMLList.appendChild")) {
          appendXmlChild(node, child, "XMLList.appendChild");
        }
        return this;
      },
      text: function(this: any) {
        return xmlDirectText(xmlListState(this, "XMLList.text"));
      },
      charAt: function(this: any, index: number) {
        return xmlStringValue(xmlListState(this, "XMLList.charAt")).charAt(Number(index));
      },
      toString: function(this: any) {
        return xmlSimpleContentString(xmlListState(this, "XMLList.toString"));
      },
      toXMLString: function(this: any) {
        return xmlStringValue(xmlListState(this, "XMLList.toXMLString"));
      },
    },
    create(target, args) {
      const input = args[0];
      let nodes: XmlNode[];
      if (input === undefined || input === null) nodes = [];
      else if (Array.isArray(input) && (input.length === 0 || isXmlNode(input[0]))) nodes = input as XmlNode[];
      else if (isXmlObject(input)) nodes = [xmlNodeState(input, "XMLList")];
      else if (isXmlListObject(input)) nodes = [...xmlListState(input, "XMLList")];
      else if (typeof input === "string") nodes = [parseXmlSource(input)];
      else nodes = [];
      const proxy = new Proxy(target, xmlListProxyHandler());
      xmlLists.set(proxy, nodes);
      return proxy;
    },
  },
  "flash.net.URLRequest": {
    fields: {
      url: { type: "String" },
      method: { type: "String" },
      data: { type: "Object" },
      requestHeaders: { type: "Array" },
      contentType: { type: "String" },
      followRedirects: { type: "Boolean" },
      manageCookies: { type: "Boolean" },
      userAgent: { type: "String" },
      authenticate: { type: "Boolean" },
      cacheResponse: { type: "Boolean" },
      useCache: { type: "Boolean" },
      digest: { type: "String" },
    },
    init(target, args) {
      target.url = args[0] === undefined || args[0] === null ? "" : String(args[0]);
      target.method = "GET";
      target.data = null;
      target.requestHeaders = [];
      target.contentType = "application/x-www-form-urlencoded";
      target.followRedirects = true;
      target.manageCookies = true;
      target.userAgent = "";
      target.authenticate = false;
      target.cacheResponse = false;
      target.useCache = true;
      target.digest = "";
    },
  },
  "flash.net.URLLoaderDataFormat": {
    staticValues: { BINARY: "binary", TEXT: "text", VARIABLES: "variables" },
  },
  "flash.net.URLRequestMethod": {
    staticValues: { GET: "GET", POST: "POST", PUT: "PUT", DELETE: "DELETE", HEAD: "HEAD", OPTIONS: "OPTIONS" },
  },
  "flash.ui.MouseCursor": {
    staticValues: {
      AUTO: "auto",
      ARROW: "arrow",
      BUTTON: "button",
      HAND: "hand",
      IBEAM: "ibeam",
    },
  },
  "flash.ui.Mouse": {
    staticAccessors: {
      cursor: {
        get: function(this: any) {
          return this.__cursor ?? "auto";
        },
        set: function(this: any, value: string) {
          this.__cursor = String(value ?? "auto");
          applyMouseCursorState(this.__cursor, this.__hidden === true);
        },
      },
    },
    statics: {
      hide: function(this: any) {
        this.__hidden = true;
        applyMouseCursorState(this.__cursor ?? "auto", true);
      },
      show: function(this: any) {
        this.__hidden = false;
        applyMouseCursorState(this.__cursor ?? "auto", false);
      },
    },
  },
  "flash.net.URLVariables": {
    dynamic: true,
    methods: {
      decode: function(this: any, source: string) {
        for (const [key, value] of new URLSearchParams(String(source ?? ""))) this[key] = value;
      },
      toString: function(this: any) {
        const params = new URLSearchParams();
        for (const key of Object.keys(this)) params.append(key, String(this[key]));
        return params.toString();
      },
    },
    init(target, args) {
      if (args[0] !== undefined && args[0] !== null) {
        for (const [key, value] of new URLSearchParams(String(args[0]))) target[key] = value;
      }
    },
  },
  "flash.net.URLLoader": {
    fields: {
      data: { type: "*" },
      dataFormat: { type: "String" },
      bytesLoaded: { type: "uint" },
      bytesTotal: { type: "uint" },
    },
    methods: {
      load: function(this: any, request: any) {
        const state = urlLoaderState(this, "URLLoader.load");
        state.controller?.abort?.();
        const controller = typeof AbortController === "function" ? new AbortController() : null;
        state.controller = controller;
        const target = this;
        target.data = null;
        target.bytesLoaded = 0;
        target.bytesTotal = 0;
        const Event = $runtimeClass("flash.events.Event");
        const ProgressEvent = $runtimeClass("flash.events.ProgressEvent");
        const IOErrorEvent = $runtimeClass("flash.events.IOErrorEvent");
        const run = async (): Promise<void> => {
          try {
            target.dispatchEvent(new Event(Event.OPEN));
            const method = String(request?.method ?? "GET").toUpperCase();
            const response = await fetch(requestUrl(request), {
              method,
              headers: requestHeaders(request),
              body: requestBody(request, method),
              signal: controller?.signal,
            });
            if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`);
            const bytes = new Uint8Array(await response.arrayBuffer());
            target.bytesLoaded = bytes.length;
            target.bytesTotal = bytes.length;
            target.dispatchEvent(new ProgressEvent(ProgressEvent.PROGRESS, false, false, bytes.length, bytes.length));
            switch (String(target.dataFormat ?? "text")) {
              case "binary": {
                const ByteArray = $runtimeClass("flash.utils.ByteArray");
                const output = new ByteArray();
                const outputState = byteState(output, "URLLoader.data");
                outputState.position = outputState.length;
                byteWriteRaw(outputState, bytes);
                outputState.position = 0;
                target.data = output;
                break;
              }
              case "variables": {
                const URLVariables = $runtimeClass("flash.net.URLVariables");
                target.data = new URLVariables(utf8Decoder.decode(bytes));
                break;
              }
              default:
                target.data = utf8Decoder.decode(bytes);
            }
            if (state.controller === controller) target.dispatchEvent(new Event(Event.COMPLETE));
          } catch (error) {
            if ((error as any)?.name === "AbortError" || state.controller !== controller) return;
            target.dispatchEvent(new IOErrorEvent(
              IOErrorEvent.IO_ERROR,
              false,
              false,
              error instanceof Error ? error.message : String(error),
            ));
          } finally {
            if (state.controller === controller) state.controller = null;
          }
        };
        void run();
      },
      close: function(this: any) {
        const state = urlLoaderState(this, "URLLoader.close");
        state.controller?.abort?.();
        state.controller = null;
      },
    },
    init(target) {
      target.data = null;
      target.dataFormat = "text";
      target.bytesLoaded = 0;
      target.bytesTotal = 0;
      urlLoaderStates.set(target, { controller: null });
    },
  },
  "flash.net.URLStream": {
    accessors: {
      connected: {
        get: function(this: any) {
          return urlStreamState(this, "URLStream.connected").connected;
        },
      },
      bytesAvailable: {
        get: function(this: any) {
          const receive = urlStreamState(this, "URLStream.bytesAvailable").receive;
          return receive.bytesAvailable;
        },
      },
      endian: {
        get: function(this: any) {
          return urlStreamState(this, "URLStream.endian").receive.endian;
        },
        set: function(this: any, value: string) {
          urlStreamState(this, "URLStream.endian").receive.endian = value;
        },
      },
      objectEncoding: {
        get: function(this: any) {
          return urlStreamState(this, "URLStream.objectEncoding").receive.objectEncoding;
        },
        set: function(this: any, value: number) {
          urlStreamState(this, "URLStream.objectEncoding").receive.objectEncoding = value;
        },
      },
    },
    methods: {
      ...streamReadMethods("URLStream"),
      load: function(this: any, request: any) {
        const state = urlStreamState(this, "URLStream.load");
        state.controller?.abort?.();
        state.receive.clear();
        const controller = typeof AbortController === "function" ? new AbortController() : null;
        state.controller = controller;
        state.connected = true;
        const target = this;
        const Event = $runtimeClass("flash.events.Event");
        const ProgressEvent = $runtimeClass("flash.events.ProgressEvent");
        const IOErrorEvent = $runtimeClass("flash.events.IOErrorEvent");
        const run = async (): Promise<void> => {
          try {
            target.dispatchEvent(new Event(Event.OPEN));
            const method = String(request?.method ?? "GET").toUpperCase();
            const response = await fetch(requestUrl(request), {
              method,
              headers: requestHeaders(request),
              body: requestBody(request, method),
              signal: controller?.signal,
            });
            if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`);
            const bytes = new Uint8Array(await response.arrayBuffer());
            const receive = byteState(state.receive, "URLStream.load");
            receive.position = receive.length;
            byteWriteRaw(receive, bytes);
            receive.position = 0;
            target.dispatchEvent(new ProgressEvent(ProgressEvent.PROGRESS, false, false, bytes.length, bytes.length));
            state.connected = false;
            if (state.controller === controller) target.dispatchEvent(new Event(Event.COMPLETE));
          } catch (error) {
            state.connected = false;
            if ((error as any)?.name === "AbortError" || state.controller !== controller) return;
            target.dispatchEvent(new IOErrorEvent(
              IOErrorEvent.IO_ERROR,
              false,
              false,
              error instanceof Error ? error.message : String(error),
            ));
          } finally {
            if (state.controller === controller) state.controller = null;
          }
        };
        void run();
      },
      close: function(this: any) {
        const state = urlStreamState(this, "URLStream.close");
        state.controller?.abort?.();
        state.controller = null;
        state.connected = false;
      },
    },
    init(target) {
      urlStreamStates.set(target, {
        controller: null,
        receive: runtimeNew("flash.utils.ByteArray"),
        connected: false,
      });
    },
  },
  "flash.media.Sound": {
    fields: {
      bytesLoaded: { type: "uint" },
      bytesTotal: { type: "uint" },
      isBuffering: { type: "Boolean" },
      url: { type: "String" },
      id3: { type: "*" },
    },
    methods: {
      load: function(this: any, request: any) {
        const state = soundState(this, "Sound.load");
        state.controller?.abort?.();
        const controller = typeof AbortController === "function" ? new AbortController() : null;
        state.controller = controller;
        const target = this;
        target.bytesLoaded = 0;
        target.bytesTotal = 0;
        target.isBuffering = true;
        const Event = $runtimeClass("flash.events.Event");
        const ProgressEvent = $runtimeClass("flash.events.ProgressEvent");
        const IOErrorEvent = $runtimeClass("flash.events.IOErrorEvent");
        const run = async (): Promise<void> => {
          try {
            target.dispatchEvent(new Event(Event.OPEN));
            const method = String(request?.method ?? "GET").toUpperCase();
            const response = await fetch(requestUrl(request), {
              method,
              headers: requestHeaders(request),
              body: requestBody(request, method),
              signal: controller?.signal,
            });
            if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`);
            const bytes = new Uint8Array(await response.arrayBuffer());
            target.bytesLoaded = bytes.length;
            target.bytesTotal = bytes.length;
            // Decoding is not implemented, so the payload is kept for `extract` to report.
            target.__soundBytes = bytes;
            target.dispatchEvent(new ProgressEvent(ProgressEvent.PROGRESS, false, false, bytes.length, bytes.length));
            target.isBuffering = false;
            if (state.controller === controller) target.dispatchEvent(new Event(Event.COMPLETE));
          } catch (error) {
            target.isBuffering = false;
            if ((error as any)?.name === "AbortError" || state.controller !== controller) return;
            target.dispatchEvent(new IOErrorEvent(
              IOErrorEvent.IO_ERROR,
              false,
              false,
              error instanceof Error ? error.message : String(error),
            ));
          } finally {
            if (state.controller === controller) state.controller = null;
          }
        };
        void run();
      },
      close: function(this: any) {
        const state = soundState(this, "Sound.close");
        state.controller?.abort?.();
        state.controller = null;
        this.isBuffering = false;
      },
      play: function(this: any) {
        throw new AS3RuntimeError("flash.media.Sound.play", "Audio playback is not implemented");
      },
      extract: function(this: any) {
        throw new AS3RuntimeError("flash.media.Sound.extract", "Audio decoding is not implemented");
      },
    },
    init(target, args) {
      target.bytesLoaded = 0;
      target.bytesTotal = 0;
      target.isBuffering = false;
      target.url = args[0] === undefined || args[0] === null ? "" : String(args[0]);
      soundStates.set(target, { controller: null });
    },
  },
};

// Every `BitmapData` write invalidates its cached blit surface; reads leave it alone. Wrapping the
// descriptor once keeps that rule in a single place instead of in each pixel operation.
const BITMAP_DATA_WRITERS = new Set([
  "applyFilter",
  "colorTransform",
  "copyChannel",
  "copyPixels",
  "dispose",
  "draw",
  "drawWithQuality",
  "fillRect",
  "floodFill",
  "merge",
  "noise",
  "paletteMap",
  "perlinNoise",
  "scroll",
  "setPixel",
  "setPixel32",
  "setPixels",
  "threshold",
]);

function invalidateBitmapSurface(target: any): void {
  const state = bitmapDataStates.get(target);
  if (state) state.version += 1;
}

for (const [methodName, method] of Object.entries(
  (EXTERNAL_DEFINITIONS["flash.display.BitmapData"] as any)?.methods ?? {},
) as Array<[string, any]>) {
  if (!BITMAP_DATA_WRITERS.has(methodName) || typeof method !== "function") continue;
  (EXTERNAL_DEFINITIONS["flash.display.BitmapData"] as any).methods[methodName] = function(
    this: any,
    ...args: any[]
  ) {
    const result = method.apply(this, args);
    invalidateBitmapSurface(this);
    return result;
  };
}

const runtimeClasses = new Map<string, any>();

/** Flash Error API shared by native Error subclasses and runtime-thrown errors. */
function installAs3ErrorApi(): void {
  const prototype = Error.prototype as any;
  if (typeof prototype.getStackTrace === "function") return;
  Object.defineProperty(prototype, "getStackTrace", {
    configurable: true,
    writable: true,
    value: function(this: any) {
      if (typeof this.stack === "string" && this.stack.length > 0) return this.stack;
      return `${this.name ?? "Error"}: ${this.message ?? ""}`;
    },
  });
}

export function $runtimeClass(fqcn: string): any {
  if (fqcn === "Error") {
    installAs3ErrorApi();
    const ErrorClass = Error as any;
    if (!ErrorClass.$desc) {
      Object.defineProperties(ErrorClass, {
        $fqcn: { value: "Error", configurable: true },
        $interfaces: { value: [], configurable: true },
        $initialized: { value: true, writable: true, configurable: true },
        $desc: {
          configurable: true,
          value: {
            name: "Error",
            abi: ABI_VERSION,
            ctor: {
              params: ["String"],
              fn: function(this: any, message?: any) {
                this.message = message === undefined || message === null ? "" : String(message);
                this.name = "Error";
                const capture = (Error as any).captureStackTrace;
                if (typeof capture === "function") capture(this);
              },
            },
          },
        },
      });
    }
    return ErrorClass;
  }
  const cached = runtimeClasses.get(fqcn);
  if (cached) return cached;
  const interfaceBinding = (
    RUNTIME_EXTERNAL_INTERFACES as Record<string, { extends: readonly string[] }>
  )[fqcn];
  if (interfaceBinding) {
    const iface = $interface({
      name: fqcn,
      abi: ABI_VERSION,
      extends: () => interfaceBinding.extends.map((parent) => $runtimeClass(parent)),
    });
    runtimeClasses.set(fqcn, iface);
    return iface;
  }
  const binding = (
    RUNTIME_EXTERNAL_CLASSES as Record<
      string,
      { base: string | null; interfaces?: readonly string[] }
    >
  )[fqcn];
  if (!binding) {
    throw new AS3RuntimeError(fqcn, `External runtime class '${fqcn}' is not bound`);
  }
  const base = binding.base ? $runtimeClass(binding.base) : null;
  const definition = EXTERNAL_DEFINITIONS[fqcn] ?? {};
  const methods = Object.fromEntries(
    Object.entries(definition.methods ?? {}).map(([name, fn]) => [
      name,
      { params: [], returns: "*", fn },
    ]),
  );
  const accessors = Object.fromEntries(
    Object.entries(definition.accessors ?? {}).map(([name, accessor]) => [
      name,
      {
        ...(accessor.get ? { get: { type: "*", fn: accessor.get } } : {}),
        ...(accessor.set ? { set: { type: "*", fn: accessor.set } } : {}),
      },
    ]),
  );
  const staticValues = Object.fromEntries(
    Object.entries(definition.staticValues ?? {}).map(([name, value]) => [
      name,
      { type: "*", value, readonly: true },
    ]),
  );
  const runtimeClass = $class({
    name: fqcn,
    abi: ABI_VERSION,
    base: base ? () => base : null,
    interfaces: () => (binding.interfaces ?? []).map((parent) => $runtimeClass(parent)),
    flags: { final: false, dynamic: definition.dynamic ?? false },
    metadata: [],
    fields: definition.fields ?? {},
    accessors,
    methods,
    statics: definition.statics ?? {},
    staticValues,
    ctor: {
      params: [],
      fn: function(this: any, ...args: any[]) {
        if (base) $super(this, base, args);
        definition.init?.(this, args);
        return definition.create?.(this, args);
      },
    },
  });
  for (const [name, accessor] of Object.entries(definition.staticAccessors ?? {})) {
    Object.defineProperty(runtimeClass, name, {
      configurable: true,
      enumerable: true,
      get: accessor.get,
      set: accessor.set,
    });
  }
  runtimeClasses.set(fqcn, runtimeClass);
  return runtimeClass;
}

export function $is(value: any, type: any): boolean {
  if (type === "*" || type === undefined || type === null) return true;
  if (type?.$isInterface) return classImplements(value?.constructor, type);
  if (typeof type === "function") return value instanceof type;
  switch (type) {
    case "int":
    case "uint":
    case "Number":
      return typeof value === "number";
    case "String":
      return typeof value === "string";
    case "Boolean":
      return typeof value === "boolean";
    case "Function":
      return typeof value === "function";
    case "Array":
      return Array.isArray(value);
    case "XML":
      return isXmlObject(value);
    case "XMLList":
      return isXmlListObject(value);
    case "void":
      return value === undefined;
    case "Error":
      return value instanceof Error;
    case "Date":
      return value instanceof Date;
    case "RegExp":
      return value instanceof RegExp;
    case "Object":
      return value !== null && (typeof value === "object" || typeof value === "function");
    case "Class":
      return typeof value === "function" && value.$desc !== undefined;
    default:
      return false;
  }
}

function classImplements(ctor: any, iface: any): boolean {
  let current = ctor;
  const seen = new Set<any>();
  while (current && !seen.has(current)) {
    seen.add(current);
    for (const implemented of current.$interfaces ?? []) {
      if (interfaceExtends(implemented, iface, new Set())) return true;
    }
    current = Object.getPrototypeOf(current);
  }
  return false;
}

function interfaceExtends(candidate: any, target: any, seen: Set<any>): boolean {
  if (!candidate || seen.has(candidate)) return false;
  seen.add(candidate);
  if (candidate === target) return true;
  return (candidate.$extends ?? []).some((parent: any) => interfaceExtends(parent, target, seen));
}

export function $cast(value: any, type: any): any {
  return $is(value, type) ? value : null;
}

export function $coerce(value: any, type: any): any {
  if (typeof type === "function" || type === "*" || type === null || type === undefined) return value;
  switch (type) {
    case "int":
      return $int(value);
    case "uint":
      return $uint(value);
    case "Number":
      return $number(value);
    case "String":
      // AS3 assignment coercion keeps null/undefined as-is; String(null) is the
      // explicit conversion, not the assignment one.
      return value === null || value === undefined ? value : $string(value);
    case "Boolean":
      return $boolean(value);
    case "void":
      return undefined;
    default:
      return value;
  }
}

export function $int(value: any): number {
  return Number(value) | 0;
}

export function $uint(value: any): number {
  return Number(value) >>> 0;
}

export function $number(value: any): number {
  return Number(value);
}

export function $string(value: any): string {
  return String(value);
}

/**
 * AS3 `typeof`: XML and XMLList report "xml", and class objects are plain objects rather
 * than JavaScript constructor functions.
 */
export function $typeof(value: any): string {
  if (isXmlObject(value) || isXmlListObject(value)) return "xml";
  if (typeof value === "function" && value.$desc !== undefined) return "object";
  return typeof value;
}

export function $boolean(value: any): boolean {
  return Boolean(value);
}

/** True for instances of AS3 classes implementing the `flash_proxy` protocol. */
function isAs3Proxy(value: any): boolean {
  return value !== null && typeof value === "object" && value.__as3Proxy === true;
}

/** `for (var key in value)`: a Map's keys, array indices as strings, or own property names. */
export function $forIn(value: any): any[] {
  if (value === null || value === undefined) return [];
  if (value instanceof Map) return [...value.keys()];
  // Dictionary keys are objects (ListenerStructs are keyed by Function), not strings.
  const dictionary = dictionaryMaps.get(value);
  if (dictionary) return [...dictionary.keys()];
  if (isAs3Proxy(value)) {
    const names: any[] = [];
    for (let index = value.nextNameIndex(0); index !== 0; index = value.nextNameIndex(index)) {
      names.push(value.nextName(index));
    }
    return names;
  }
  if (Array.isArray(value)) return Array.from({ length: value.length }, (_, index) => String(index));
  if (isXmlListObject(value)) return xmlListState(value, "$forIn").map((_, index) => String(index));
  if (isEnumerableObject(value)) return Object.keys(value);
  return [];
}

/** `for each (var value in value)`: a Map's values, array elements, or own property values. */
export function $forEach(value: any): any[] {
  if (value === null || value === undefined) return [];
  if (value instanceof Map) return [...value.values()];
  const dictionary = dictionaryMaps.get(value);
  if (dictionary) return [...dictionary.values()];
  if (isAs3Proxy(value)) {
    const items: any[] = [];
    for (let index = value.nextNameIndex(0); index !== 0; index = value.nextNameIndex(index)) {
      items.push(value.nextValue(index));
    }
    return items;
  }
  if (Array.isArray(value)) return [...value];
  if (isXmlListObject(value)) return xmlListState(value, "$forEach").map(wrapXmlNode);
  if (isEnumerableObject(value)) return Object.keys(value).map((key) => value[key]);
  return [];
}

/**
 * Computed member access (`value[key]`).
 *
 * JS property keys are always strings, which loses Dictionary keys that are
 * objects or functions (listener structs are function-keyed). These helpers keep
 * the raw key for Dictionary-backed values and fall back to ordinary indexing.
 */
export function $index(value: any, key: any): any {
  const dictionary = dictionaryMaps.get(value);
  if (dictionary) return dictionary.get(dictionaryKey(key));
  if (isAs3Proxy(value)) return value.getProperty(key);
  const byte = byteArrayIndexGet(value, key);
  if (byte !== undefined) return byte;
  return value?.[key];
}

export function $indexSet(value: any, key: any, assigned: any): any {
  const dictionary = dictionaryMaps.get(value);
  if (dictionary) {
    dictionary.set(dictionaryKey(key), assigned);
  } else if (isAs3Proxy(value)) {
    value.setProperty(key, assigned);
  } else if (!byteArrayIndexSet(value, key, assigned)) {
    value[key] = assigned;
  }
  return assigned;
}

/** True when a class in `value`'s chain declares `name` as an instance member. */
function declaresInstanceMember(value: any, name: string): boolean {
  let ctor = value?.constructor;
  const seen = new Set<any>();
  while (ctor && !seen.has(ctor)) {
    seen.add(ctor);
    const definition = ctor.$desc;
    if (definition) {
      for (const table of [definition.fields, definition.accessors, definition.methods]) {
        if (table && Object.prototype.hasOwnProperty.call(table, name)) return true;
      }
    }
    ctor = Object.getPrototypeOf(ctor);
  }
  return false;
}

/** AS3 `key in value`: Dictionary keys and flash_proxy `hasProperty` come first. */
export function $in(key: any, value: any): boolean {
  const dictionary = dictionaryMaps.get(value);
  if (dictionary) return dictionary.has(dictionaryKey(key));
  if (isAs3Proxy(value)) {
    return typeof value.hasProperty === "function" ? Boolean(value.hasProperty(key)) : key in value;
  }
  return key in value;
}

/** AS3 `delete value[name]`: declared members are sealed and report `false`. */
export function $deleteMember(value: any, name: string): boolean {
  if (value === null || value === undefined) {
    throw $error("TypeError", "Error #1009: Cannot access a property or method of a null object reference.");
  }
  const dictionary = dictionaryMaps.get(value);
  if (dictionary) return dictionary.delete(dictionaryKey(name));
  if (isAs3Proxy(value)) {
    return typeof value.deleteProperty === "function" ? Boolean(value.deleteProperty(name)) : true;
  }
  const definition = value.$desc;
  if (definition) {
    for (const table of [definition.statics, definition.staticValues, definition.staticAccessors]) {
      if (table && Object.prototype.hasOwnProperty.call(table, name)) return false;
    }
    return delete value[name];
  }
  if (declaresInstanceMember(value, name)) return false;
  return delete value[name];
}

export function $indexDelete(value: any, key: any): boolean {
  const dictionary = dictionaryMaps.get(value);
  if (dictionary) return dictionary.delete(dictionaryKey(key));
  return $deleteMember(value, String(key));
}

export function $indexUpdate(value: any, key: any, op: "++" | "--", prefix: boolean): any {
  const current = $index(value, key);
  const next = op === "++" ? current + 1 : current - 1;
  $indexSet(value, key, next);
  return prefix ? next : current;
}

/**
 * `Vector.<T>(value)`: copies an Array or an existing Vector into a new vector of T,
 * coercing primitives the way Flash's assignment coercion does. Anything else is null.
 */
export function $vectorCast(value: any, elementType: any): any[] | null {
  if (value === null || value === undefined || !Array.isArray(value)) return null;
  const result = $vector(elementType, [], value.length);
  for (let index = 0; index < value.length; index += 1) {
    result[index] = $coerce(value[index], elementType);
  }
  return result;
}

export function $vector(elementType: any, values: any[] = [], length?: number): any[] {
  const result = values.length > 0 || length === undefined
    ? [...values]
    : new Array(length);
  Object.defineProperty(result, "__elementType", {
    value: elementType,
    enumerable: false,
    configurable: true,
  });
  return result;
}

export function $error(code: string, message: string): Error {
  installAs3ErrorApi();
  const error = new Error(message);
  error.name = code;
  return error;
}

export function trace(...values: any[]): void {
  console.log(...values);
}

// AS3 `trace` is a top-level player function, and the backend emits calls to the bare identifier.
(globalThis as any).trace ??= trace;
installArrayIntrinsics();
Object.defineProperty(Array.prototype, "sort", {
  configurable: true,
  writable: true,
  value: flashSort,
});