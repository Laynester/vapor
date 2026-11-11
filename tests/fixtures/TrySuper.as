package demo
{
    public class TrySuper extends TrySuperBase
    {
        public function TrySuper(value:String)
        {
            try
            {
                super(value);
            }
            catch (error:Error)
            {
                this.value = "caught";
            }
        }
    }
}

class TrySuperBase
{
    public var value:String;

    public function TrySuperBase(value:String)
    {
        this.value = value;
    }
}
