package demo
{
    import flash.geom.Point;
    import flash.utils.getDefinitionByName;
    import flash.utils.getQualifiedClassName;
    import flash.utils.getTimer;
    import flash.utils.setTimeout;

    public class Reflection
    {
        public function Reflection()
        {
        }

        public function monotonic():Boolean
        {
            var first:Number = getTimer();
            var later:Number = getTimer();
            return later >= first;
        }

        public function className():String
        {
            return getQualifiedClassName(new Point(1, 2));
        }

        public function sameClass():Boolean
        {
            return getDefinitionByName("flash.geom.Point") == Point;
        }

        public function later(callback:Function):void
        {
            setTimeout(function():void
            {
                callback("fired");
            }, 1);
        }
    }
}
