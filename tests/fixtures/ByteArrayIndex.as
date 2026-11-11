package demo
{
    import flash.utils.ByteArray;

    public class ByteArrayIndex
    {
        public function ByteArrayIndex()
        {
        }

        public function readWrite():String
        {
            var bytes:ByteArray = new ByteArray();
            bytes.writeUTFBytes("AB");
            var first:int = bytes[0];
            var second:int = bytes[1];
            bytes[0] = 0x43;
            bytes[3] = 0x44;
            return first + "|" + second + "|" + bytes[0] + "|" + bytes.length + "|" + bytes[2] + "|" + bytes[3];
        }

        public function decodeInPlace():String
        {
            var text:String = "bG9naW5fd2luZG93";
            var bytes:ByteArray = new ByteArray();
            bytes.writeUTFBytes(text);
            var index:int = 0;
            var output:int = 0;
            while (index < text.length)
            {
                bytes[output++] = bytes[index++];
            }
            bytes.length = output;
            bytes.position = 0;
            return bytes.readUTFBytes(bytes.length);
        }
    }
}
