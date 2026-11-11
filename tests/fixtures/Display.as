package demo
{
    import flash.display.Sprite;
    import flash.events.Event;
    import flash.events.IEventDispatcher;

    public class Display extends Sprite implements IEventDispatcher
    {
        private var pings:int = 0;
        private var phase:int = 0;

        public function Display()
        {
            super();
            addEventListener("ping", onPing);
            addChild(new Sprite());
        }

        private function onPing(event:Event):void
        {
            pings++;
            phase = event.eventPhase;
        }

        public function ping():int
        {
            dispatchEvent(new Event("ping"));
            return pings;
        }

        public function childCount():int
        {
            return numChildren;
        }

        public function get lastPhase():int
        {
            return phase;
        }
    }
}
