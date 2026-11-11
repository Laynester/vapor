package demo
{
    import flash.utils.Dictionary;

    public class TypedLocal
    {
        public function TypedLocal()
        {
        }

        public function lookup():String
        {
            var xml:XML = new XML('<window type="frame" style="101" />');
            var type:String;
            var style:uint;
            type = xml.attribute("type");
            style = xml.attribute("style");
            var table:Dictionary = new Dictionary();
            table["frame"] = 35;
            return table[type] + "|" + style;
        }
    }
}
