package demo
{
    public class AccessorBase
    {
        protected var _procedure:Function = null;

        public function get procedure():Function
        {
            return (this._procedure != null) ? this._procedure : this.nullEventProc;
        }

        public function set procedure(k:Function):void
        {
            this._procedure = k;
        }

        private function nullEventProc(a:*, b:*):void
        {
        }

        public function callProcedure():String
        {
            return typeof this.procedure;
        }
    }

    public class AccessorChild extends AccessorBase
    {
        override public function set procedure(k:Function):void
        {
            this._procedure = k;
        }
    }
}
