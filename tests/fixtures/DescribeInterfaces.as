package demo
{
    import flash.utils.describeType;
    import flash.utils.getQualifiedClassName;

    public interface IMarker
    {
        function ping():void;
    }

    public class MarkedBase implements IMarker
    {
        public function ping():void
        {
        }
    }

    public class MarkedChild extends MarkedBase
    {
    }

    public class ReflectProbe
    {
        public function implementsInherited():Boolean
        {
            var info:XML = describeType(MarkedChild);
            return info.factory.implementsInterface.(@type == getQualifiedClassName(IMarker)).length() > 0;
        }

        public function hasFactory():Boolean
        {
            return describeType(MarkedChild).factory.length() > 0;
        }
    }
}
