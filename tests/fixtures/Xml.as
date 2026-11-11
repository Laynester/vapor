package demo
{
    public class Xml
    {
        public function summary():String
        {
            var config:XML = <config><item id="1">one</item><item id="2">two</item></config>;
            var items:XMLList = config.item;
            var count:int = items.length();
            var first:String = String(items[0].@id);
            var text:String = items[1].text();
            var ids:XMLList = config..item.@id;
            var all:XMLList = config..*;
            var parsed:XML = new XML("<root><child>c</child></root>");
            return count + ":" + first + ":" + text + ":" + ids.toString() + ":" + all.length() + ":" + parsed..child.text();
        }
    }
}
