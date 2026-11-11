package demo
{
    import flash.display.Bitmap;
    import flash.display.Shape;
    import flash.display.Sprite;
    import flash.utils.ByteArray;
    import mx.core.BitmapAsset;
    import mx.core.ByteArrayAsset;

    [Embed(source="pixel.png")]
    public class BootPixel extends BitmapAsset
    {
    }

    [Embed(source="manifest.xml", mimeType="text/xml")]
    public class BootManifest extends ByteArrayAsset
    {
    }

    public class Boot
    {
        public var root:Sprite;
        public var manifest:String;

        public function build():void
        {
            root = new Sprite();

            var shape:Shape = new Shape();
            shape.graphics.beginFill(0x00ff00);
            shape.graphics.drawRect(10, 20, 30, 40);
            shape.graphics.endFill();
            root.addChild(shape);

            var bytes:BootManifest = new BootManifest();
            manifest = bytes.readUTFBytes(bytes.length);

            var bitmap:BootPixel = new BootPixel();
            bitmap.x = 60;
            bitmap.y = 20;
            root.addChild(bitmap);
        }

        public function run():String
        {
            return "boot:" + root.numChildren + ":" + (manifest.indexOf("logo") >= 0);
        }
    }
}
