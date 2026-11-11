package demo
{
    public class GuardError
    {
        public var message:String;

        public function GuardError(message:String)
        {
            this.message = message;
        }
    }

    public class Closures
    {
        private var base:int = 10;

        public function Closures()
        {
        }

        public function makeAdder(offset:int):Function
        {
            var total:int = 0;
            return function(value:int):int
            {
                total += value + offset + base;
                return total;
            };
        }

        public function laterCapture():Function
        {
            var read:Function = function():int
            {
                return later;
            };
            var later:int = 7;
            return read;
        }

        public function classify(value:int):String
        {
            var result:String = "";
            switch (value)
            {
                case 1:
                    result = "one";
                    break;
                case 2:
                case 3:
                    result = "few";
                    break;
                default:
                    result = "many";
                    break;
            }
            return result;
        }

        public function guarded(action:String):String
        {
            var log:String = "";
            try
            {
                log += "try";
                if (action == "guard") throw new GuardError("guard");
                if (action == "plain") throw new Error("plain");
                log += "-ok";
            }
            catch (error:GuardError)
            {
                log += "-guard:" + error.message;
            }
            catch (error:Error)
            {
                log += "-error:" + error.message;
            }
            finally
            {
                log += "-finally";
            }
            return log;
        }

        public function rethrows(action:String):String
        {
            var log:String = "";
            try
            {
                try
                {
                    if (action == "guard") throw new GuardError("g");
                    throw "text";
                }
                catch (error:GuardError)
                {
                    log += "guard";
                }
            }
            catch (text:String)
            {
                log += "-string:" + text;
            }
            return log;
        }
    }
}
