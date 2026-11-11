package demo
{
    import flash.utils.Proxy;
    import flash.utils.flash_proxy;

    use namespace flash_proxy;

    public class ProxyMap extends Proxy
    {
        private var keys:Array = [];
        private var values:Array = [];

        public function ProxyMap()
        {
            super();
        }

        override flash_proxy function getProperty(key:*):*
        {
            var index:int = keys.indexOf(key);
            return index < 0 ? null : values[index];
        }

        override flash_proxy function setProperty(key:*, value:*):void
        {
            var index:int = keys.indexOf(key);
            if (index < 0)
            {
                keys.push(key);
                values.push(value);
            }
            else
            {
                values[index] = value;
            }
        }

        override flash_proxy function nextNameIndex(index:int):int
        {
            return index < keys.length ? index + 1 : 0;
        }

        override flash_proxy function nextName(index:int):String
        {
            return keys[index - 1];
        }

        override flash_proxy function nextValue(index:int):*
        {
            return values[index - 1];
        }
    }

    public class ProxyProbe
    {
        public function write(map:ProxyMap, key:String, value:String):void
        {
            map[key] = value;
        }

        public function read(map:ProxyMap, key:String):String
        {
            return map[key];
        }

        public function names(map:ProxyMap):Array
        {
            var out:Array = [];
            for (var name:String in map)
            {
                out.push(name);
            }
            return out;
        }

        public function valuesOf(map:ProxyMap):Array
        {
            var out:Array = [];
            for each (var value:String in map)
            {
                out.push(value);
            }
            return out;
        }
    }
}
