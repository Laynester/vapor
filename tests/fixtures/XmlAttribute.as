package demo
{
    public class XmlAttribute
    {
        public function write():String
        {
            var node:XML = <root/>;
            node.@id = "plain";
            node.@["set-type"] = "computed";
            return String(node.@id) + ":" + String(node.@["set-type"]);
        }
    }
}
