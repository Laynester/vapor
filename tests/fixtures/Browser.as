package demo
{
    import flash.display.Bitmap;
    import flash.display.BitmapData;
    import flash.display.Shape;
    import flash.display.Sprite;
    import flash.text.TextField;

    public class Browser
    {
        public var root:Sprite;

        public function build():void
        {
            root = new Sprite();

            var shape:Shape = new Shape();
            shape.graphics.beginFill(0x00ff00);
            shape.graphics.drawRect(10, 20, 30, 40);
            shape.graphics.endFill();
            root.addChild(shape);

            var field:TextField = new TextField();
            field.text = "hi";
            field.x = 5;
            field.y = 5;
            root.addChild(field);

            var data:BitmapData = new BitmapData(2, 1);
            data.setPixel32(0, 0, 0xff0000ff);
            var bitmap:Bitmap = new Bitmap(data);
            bitmap.x = 60;
            bitmap.y = 20;
            root.addChild(bitmap);
        }

        public function run():String
        {
            return "browser:" + root.numChildren + ":" + root.loaderInfo.parameters["mode"];
        }
    }
}
