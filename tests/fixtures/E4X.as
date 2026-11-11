package demo
{
    public class E4X
    {
        public function parse():void
        {
            var xml:XML = <config><item id="1"/><item id="2">two</item></config>;
            var firstId:String = xml.item[0].@id;
            var all:XMLList = xml..item;
            var filtered:XMLList = xml..item.(@id == "2");
            var text:String = xml.item[1].text();
            var qualified:String = xml.ns::name;
            var nested:XML = <root><child><leaf/></child></root>;
            var leaf:XMLList = nested..*..leaf;
        }
    }
}
