package demo
{
    import flash.net.Socket;

    public class Packet
    {
        public function Packet()
        {
        }

        public function write(socket:Socket, id:uint, name:String):void
        {
            socket.writeUnsignedInt(id);
            socket.writeUTF(name);
            socket.flush();
        }
    }
}
