package demo
{
    import flash.display.MovieClip;

    public class Hello extends MovieClip
    {
        private var count:int = 0;

        public function Hello()
        {
            super();
        }

        public function greet(name:String):String
        {
            if (name == null)
            {
                return "hello";
            }
            count++;
            return "hello " + name;
        }
    }
}
