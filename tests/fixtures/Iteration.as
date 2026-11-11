package demo
{
    public class KeyHolder
    {
        public var key:String = "";
    }

    public class Iteration
    {
        public function Iteration()
        {
        }

        public function keysOf(source:Object):String
        {
            var keys:Array = [];
            for (var key:String in source)
            {
                keys.push(key);
            }
            keys.sort();
            return keys.join(",");
        }

        public function valuesOf(source:Object):String
        {
            var values:Array = [];
            for each (var value:Object in source)
            {
                values.push("" + value);
            }
            values.sort();
            return values.join(",");
        }

        public function indexCount(values:Array):int
        {
            var count:int = 0;
            for (var index:String in values)
            {
                count++;
            }
            return count;
        }

        public function sum(vector:Vector.<int>):int
        {
            var total:int = 0;
            for each (var value:int in vector)
            {
                total += value;
            }
            return total;
        }

        public function firstKey(source:Object, holder:KeyHolder):String
        {
            for (holder.key in source)
            {
            }
            return holder.key;
        }

        public function labelled():String
        {
            var log:String = "";
            outer:
            for (var i:int = 0; i < 3; i++)
            {
                for (var j:int = 0; j < 3; j++)
                {
                    if (i == 2) break outer;
                    if (j == 1) continue outer;
                    log += i + "" + j;
                }
            }
            return log;
        }
    }
}
