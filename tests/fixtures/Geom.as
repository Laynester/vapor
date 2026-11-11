package demo
{
    import flash.geom.ColorTransform;
    import flash.geom.Matrix;
    import flash.geom.Point;
    import flash.geom.Rectangle;

    public class Geom
    {
        public function Geom()
        {
        }

        public function move(point:Point, dx:Number, dy:Number):Point
        {
            var copy:Point = point.clone();
            copy.offset(dx, dy);
            return copy;
        }

        public function lengthOf(x:Number, y:Number):Number
        {
            var point:Point = new Point(x, y);
            return point.length;
        }

        public function bounds():Rectangle
        {
            var first:Rectangle = new Rectangle(10, 10, 100, 50);
            var second:Rectangle = new Rectangle(60, 20, 100, 100);
            return first.intersection(second);
        }

        public function transformed():Point
        {
            var matrix:Matrix = new Matrix();
            matrix.translate(10, 5);
            matrix.scale(2, 3);
            return matrix.transformPoint(new Point(1, 1));
        }

        public function tint():Number
        {
            var transform:ColorTransform = new ColorTransform();
            transform.color = 0x336699;
            return transform.color;
        }

        public function span(rect:Rectangle):Number
        {
            return rect.right - rect.left;
        }
    }
}
