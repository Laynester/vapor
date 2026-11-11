package demo
{
    import flash.utils.Dictionary;

    public class Lookup
    {
        public function Lookup()
        {
        }

        public function roundTrip():String
        {
            var dict:Dictionary = new Dictionary();
            dict["a"] = 1;
            dict["b"] = 2;
            dict["a"] = dict["a"] + 10;

            var keys:String = "";
            for (var key:String in dict)
            {
                keys += key;
            }
            return keys + "|" + dict["a"] + "|" + dict.has("b") + "|" + dict.get("b");
        }
    }
}
