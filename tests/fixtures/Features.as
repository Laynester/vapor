package demo
{
    import flash.utils.getDefinitionByName;

    public interface IThing
    {
        function get value():int;
        function set value(v:int):void;
    }

    public class Features implements IThing
    {
        [Embed(source="asset.png", mimeType="image/png")]
        public static const IMAGE:Class;

        private var _value:int = 0;
        private var _map:Object = {};

        public function get value():int
        {
            return _value;
        }

        public function set value(v:int):void
        {
            _value = v;
        }

        public function compute(items:Vector.<int>, ...rest):Array
        {
            var out:Array = [];
            for each (var item:int in items)
            {
                out.push(item);
            }
            for (var key:String in _map)
            {
                out.push(key);
            }
            var i:int = 0;
            while (i < out.length)
            {
                i++;
            }
            do
            {
                i--;
            }
            while (i > 0);
            return out;
        }

        public function classify(n:int):String
        {
            switch (n)
            {
                case 0:
                    return "zero";
                case 1:
                case 2:
                    return "small";
                default:
                    return "other";
            }
        }

        public function guard():void
        {
            try
            {
                throw new Error("boom");
            }
            catch (e:Error)
            {
                _value = 1;
            }
            finally
            {
                _value = 2;
            }
        }

        public function reflect():Class
        {
            return getDefinitionByName("Features") as Class;
        }
    }
}
