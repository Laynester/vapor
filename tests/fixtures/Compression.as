package demo
{
    import flash.utils.ByteArray;

    public class Compression
    {
        public function Compression()
        {
        }

        public function roundTrip():String
        {
            var text:String = "";
            var index:int = 0;
            while (index < 64)
            {
                text += "habbo-flash-runtime;";
                index++;
            }

            var bytes:ByteArray = new ByteArray();
            bytes.writeUTFBytes(text);
            var original:int = bytes.length;
            bytes.compress();
            var packed:int = bytes.length;
            bytes.uncompress();
            var position:int = bytes.position;
            var restored:String = bytes.readUTFBytes(bytes.length);
            return packed + "|" + (packed < original) + "|" + (restored == text) + "|" + position;
        }

        public function rawRoundTrip():String
        {
            var bytes:ByteArray = new ByteArray();
            bytes.writeUTFBytes("raw-deflate-payload");
            var plain:int = bytes.length;
            bytes.deflate();
            bytes.inflate();
            var restored:String = bytes.readUTFBytes(bytes.length);
            return (bytes.length == plain) + "|" + restored;
        }
    }
}
