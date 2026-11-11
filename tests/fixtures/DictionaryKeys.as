package demo
{
    import flash.utils.Dictionary;

    public class DictionaryKeys
    {
        public function DictionaryKeys()
        {
        }

        public function primitiveKeyAlias():String
        {
            var dict:Dictionary = new Dictionary();
            dict[10] = "ten";
            dict["text"] = "hello";
            return dict["10"] + "|" + dict[10] + "|" + dict["text"];
        }

        public function enumerateKeys():String
        {
            var dict:Dictionary = new Dictionary();
            dict[10] = "a";
            dict[20] = "b";
            var result:String = "";
            for (var key:String in dict)
            {
                result += key + ":" + dict[key] + ";";
            }
            return result;
        }

        public function hasMixedKeys():String
        {
            var dict:Dictionary = new Dictionary();
            dict[10] = "x";
            return (dict.has("10") ? "1" : "0") + (dict.has(10) ? "1" : "0");
        }

        public function objectKeysRemainDistinct():String
        {
            var dict:Dictionary = new Dictionary();
            var first:Object = {};
            var second:Object = {};
            dict[first] = "a";
            dict[second] = "b";
            return dict[first] + "|" + dict[second] + "|" + (dict[first] == dict[second]);
        }

        public function numericReturnCoerced():String
        {
            var value:Number = 12.5;
            return value;
        }

        public function truncatedIntReturn():String
        {
            var value:Number = 3.9;
            var truncated:int = this.asInt(value);
            return truncated;
        }

        private function asInt(value:Number):int
        {
            return value;
        }
    }
}
