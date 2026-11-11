package demo
{
    public namespace impl = "http://example.com/as3js/impl";

    public class Advanced
    {
        {
            this.ready = true;
        }

        public var ready:Boolean = false;
        public var wildcard:*=null;
        impl var hidden:int;

        impl function hiddenMethod():void
        {
        }

        public function typed():Vector.<String>
        {
            return new <String>["a", "b"];
        }

        public function attribute(x:XML):void
        {
            x.@["set-type"] = "value";
        }

        public function bitwise():void
        {
            var flags:int = 0;
            flags ||= 1;
            flags &&= 2;
        }
    }
}
