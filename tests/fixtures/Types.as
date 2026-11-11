package demo
{
    public namespace internal_ns = "http://example.com/as3js";

    public class Types
    {
        public var nested:Vector.<Vector.<int>>;
        public var anything:*;
        public var callback:Function;

        public function make():Vector.<Vector.<int>>
        {
            var value:Vector.<Vector.<int>> = new Vector.<Vector.<int>>();
            value.push(new Vector.<int>());
            return value;
        }

        public function call(fn:Function, value:* = null, ...rest):*
        {
            return fn(value);
        }

        public function test(value:*):Boolean
        {
            return value is Vector.<int>;
        }

        public function cast(value:Object):Vector.<int>
        {
            return value as Vector.<int>;
        }
    }
}
