package demo
{
    public class Primitives
    {
        private var _stored:int = 0;

        public function Primitives()
        {
        }

        private function two(first:int, second:int):void
        {
            _stored = first + second;
        }

        public function coercions():String
        {
            var zero:Number = 0;
            var truncated:int = 3.9;
            var negative:int = -3.9;
            var notANumber:int = zero / zero;
            var infinite:int = 1 / zero;
            var large:Number = 4294967295;
            var wrapped:int = large;
            var minusOne:Number = -1;
            var unsigned:uint = minusOne;
            var summed:int = 2147483647;
            summed++;
            summed += 0.5;
            var post:int = summed++;
            var average:Number = 7 / 2;
            var assigned:uint = 5;
            assigned -= 7;
            return truncated + "|" + negative + "|" + notANumber + "|" + infinite + "|" + wrapped + "|" + unsigned + "|" + summed + "|" + post + "|" + average + "|" + assigned;
        }

        public function operators():String
        {
            var zero:Number = 0;
            var nan:Number = zero / zero;
            var nothing:Object = null;
            var missing:*;
            var bits:int = 0x7fffffff << 1;
            var rotated:int = 4 << 33;
            var arithmetic:int = -7 >> 1;
            var mask:uint = 0xffffffff;
            var high:uint = mask >>> 28;
            return (nan == nan) + "|" + (nan != nan) + "|" + (nothing == missing) + "|" + (nothing === missing) + "|" + (1 == "1") + "|" + (1 === "1") + "|" + ("10" < "9") + "|" + (10 < 9) + "|" + bits + "|" + rotated + "|" + arithmetic + "|" + high;
        }

        public function typeofValues():String
        {
            var xml:XML = <root><child/></root>;
            var list:XMLList = xml.children();
            var plain:Object = { value: 1 };
            var handler:Function = function(first:int):void { };
            var missing:*;
            return (typeof xml) + "|" + (typeof list) + "|" + (typeof plain) + "|" + (typeof handler) + "|" + (typeof 3) + "|" + (typeof "text") + "|" + (typeof null) + "|" + (typeof missing);
        }

        public function arity():String
        {
            var handler:Function = function(first:int, second:int):void { };
            return handler.length + "|" + this.two.length;
        }
    }
}
