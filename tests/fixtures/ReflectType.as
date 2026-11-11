package demo
{
    import flash.utils.describeType;

    public class ReflectType
    {
        public var label:String = "x";
        public static const TAG:String = "rt";

        public function greet(name:String):String
        {
            return "hi " + name;
        }

        public function describe():String
        {
            return describeType(ReflectType).toString();
        }
    }
}
