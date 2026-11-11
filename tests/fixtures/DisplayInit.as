package demo
{
    import flash.display.Sprite;

    public class DisplayInit extends Sprite
    {
        private var observed:Array = null;

        public function DisplayInit()
        {
            super();
            this.filters = [1, 2];
        }

        override public function get filters():Array
        {
            return observed;
        }

        override public function set filters(value:Array):void
        {
            observed = [numChildren, value.length];
        }
    }
}
