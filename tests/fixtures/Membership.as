package demo
{
    import flash.utils.Dictionary;

    public class Membership
    {
        public var declaredField:int = 1;

        public function Membership()
        {
        }

        public function dictionaryMembership():String
        {
            var map:Dictionary = new Dictionary();
            map["alpha"] = 1;
            map[7] = 2;
            var objectKey:Object = { name: "key" };
            map[objectKey] = 3;
            return ("alpha" in map) + "|" + (7 in map) + "|" + ("7" in map) + "|" + (objectKey in map) + "|" + ("missing" in map);
        }

        public function objectMembership():String
        {
            var plain:Object = { value: 1 };
            var values:Array = [10, 20];
            return ("value" in plain) + "|" + ("missing" in plain) + "|" + (1 in values) + "|" + (2 in values) + "|" + ("length" in values);
        }

        public function deleteDynamic():String
        {
            var plain:Object = { value: 1 };
            var removed:Boolean = delete plain.value;
            return removed + "|" + ("value" in plain);
        }

        public function deleteSealed():String
        {
            var removed:Boolean = delete this.declaredField;
            return removed + "|" + this.declaredField;
        }
    }
}
