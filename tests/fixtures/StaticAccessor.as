package demo
{
    public class StaticAccessor
    {
        private static var _flag:uint = 0;
        private static var _queue:Array = null;

        public static function get flag():uint
        {
            return _flag;
        }

        public static function set flag(k:uint):void
        {
            _flag = k;
        }

        public static function get queue():Array
        {
            return _queue;
        }

        public static function set queue(k:Array):void
        {
            _queue = k;
        }

        public static function set mode(k:uint):void
        {
            if (k == 0)
            {
                queue = [];
            }
        }

        public function StaticAccessor()
        {
            mode = 0;
        }
    }
}
