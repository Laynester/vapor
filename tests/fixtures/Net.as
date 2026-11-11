package demo
{
    import flash.events.Event;
    import flash.events.IOErrorEvent;
    import flash.net.URLLoader;
    import flash.net.URLLoaderDataFormat;
    import flash.net.URLRequest;
    import flash.net.URLStream;
    import flash.net.URLVariables;

    public class Net
    {
        public var loaded:String = "";
        public var streamed:String = "";
        public var failed:String = "";

        public function encode():String
        {
            var vars:URLVariables = new URLVariables();
            vars.a = "1 2";
            vars.b = "&";
            return vars.toString();
        }

        public function loadText(url:String):void
        {
            var loader:URLLoader = new URLLoader();
            loader.dataFormat = URLLoaderDataFormat.TEXT;
            loader.addEventListener(Event.COMPLETE, function(event:Event):void {
                loaded = String(loader.data);
            });
            loader.addEventListener(IOErrorEvent.IO_ERROR, function(event:IOErrorEvent):void {
                failed = event.text;
            });
            loader.load(new URLRequest(url));
        }

        public function loadStream(url:String):void
        {
            var stream:URLStream = new URLStream();
            stream.addEventListener(Event.COMPLETE, function(event:Event):void {
                streamed = stream.readUTFBytes(stream.bytesAvailable);
            });
            stream.load(new URLRequest(url));
        }
    }
}
