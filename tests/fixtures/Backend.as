package demo
{
    public interface IGreeter
    {
        function greeting():String;
    }

    public class Base implements IGreeter
    {
        public var base:int = 2;
        private var _label:String = "base";

        public function Base(x:int)
        {
            this.base = x;
        }

        public function describe():String
        {
            return "base:" + this.base;
        }

        public function get doubled():int
        {
            return this.base * 2;
        }

        public function get label():String
        {
            return _label;
        }

        public function set label(v:String):void
        {
            _label = v;
        }

        public function greeting():String
        {
            return this.label;
        }

        public function isGreeter():Boolean
        {
            return this is IGreeter;
        }

        public function makeVector():Vector.<int>
        {
            var values:Vector.<int> = new Vector.<int>();
            values.push(1);
            values.push(2);
            return values;
        }
    }

    public class Child extends Base
    {
        public static const TAG:String = "child";
        public var extra:int = 3;
        public var unset:int;

        public function Child(x:int)
        {
            super(x + 1);
            this.extra = 4;
        }

        override public function describe():String
        {
            return super.describe() + ":" + this.extra;
        }

        override public function get doubled():int
        {
            return super.doubled + 1;
        }
    }
}