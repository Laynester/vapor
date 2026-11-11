package demo
{
    public class ConstructorBase
    {
        public var observed:String = null;

        public function ConstructorBase()
        {
            observed = snapshot();
        }

        public function snapshot():String
        {
            return "base";
        }
    }

    public class ConstructorOrder extends ConstructorBase
    {
        private var state:String = "field";

        public function ConstructorOrder()
        {
            state = "ready";
            super();
        }

        override public function snapshot():String
        {
            return state;
        }
    }
}
