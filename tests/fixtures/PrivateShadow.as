package demo
{
    public class PrivateShadowBase
    {
        public var log:String = "";

        public function run():String
        {
            var viaThis:Function = this.tick;
            viaThis();
            var viaName:Function = tick;
            viaName();
            return log;
        }

        private function tick():void
        {
            log = log + "base;";
        }
    }

    public class PrivateShadow extends PrivateShadowBase
    {
        private function tick():void
        {
            log = log + "derived;";
        }
    }
}
