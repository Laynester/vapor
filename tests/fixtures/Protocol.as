package demo
{
    import flash.utils.ByteArray;

    public class Protocol
    {
        public function Protocol()
        {
        }

        public function roundTrip():String
        {
            var bytes:ByteArray = new ByteArray();
            bytes.writeByte(0x2a);
            bytes.writeShort(300);
            bytes.writeInt(-70000);
            bytes.writeUTF("h\u00e9llo");
            bytes.writeFloat(1.5);

            bytes.position = 0;
            var first:int = bytes.readByte();
            var second:int = bytes.readShort();
            var third:int = bytes.readInt();
            var text:String = bytes.readUTF();
            var fourth:Number = bytes.readFloat();
            return first + "|" + second + "|" + third + "|" + text + "|" + fourth + "|" + bytes.position + "|" + bytes.length;
        }

        public function littleEndian():String
        {
            var bytes:ByteArray = new ByteArray();
            bytes.endian = "littleEndian";
            bytes.writeShort(0x0102);
            bytes.position = 0;
            return "" + bytes.readShort();
        }

        public function eof():String
        {
            var bytes:ByteArray = new ByteArray();
            try
            {
                bytes.readInt();
                return "no-error";
            }
            catch (error:Error)
            {
                return error.name;
            }
        }

        public function copy():String
        {
            var source:ByteArray = new ByteArray();
            source.writeByte(1);
            source.writeByte(2);
            source.writeByte(3);

            var target:ByteArray = new ByteArray();
            source.position = 1;
            target.writeBytes(source, 0, 2);
            target.position = 0;
            return target.length + ":" + target.readByte() + target.readByte();
        }
    }
}
