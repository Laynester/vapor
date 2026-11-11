package demo
{
    public class SuperBase
    {
        private var _value:int = 0;

        public function get value():int
        {
            return _value;
        }

        public function set value(v:int):void
        {
            _value = v;
        }
    }

    public class SuperSet extends SuperBase
    {
        override public function get value():int
        {
            return super.value;
        }

        override public function set value(v:int):void
        {
            super.value = v + 1;
        }

        public function bump(by:int):int
        {
            super.value += by;
            return super.value;
        }

        public function postfix():int
        {
            return super.value++;
        }
    }
}
