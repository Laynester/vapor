package demo
{
    import flash.display.Sprite;

    public class ExternalVars extends Sprite
    {
        public function describe():String
        {
            return String(this.loaderInfo.parameters["mode"]) + ":" +
                String(this.loaderInfo.parameters["count"]);
        }
    }
}
