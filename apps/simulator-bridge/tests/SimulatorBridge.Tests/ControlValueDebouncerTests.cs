using SharedCockpit.Bridge.Bridge;
using Xunit;

namespace SimulatorBridge.Tests;

public class ControlValueDebouncerTests
{
    [Fact]
    public void FirstChange_EmitsImmediately()
    {
        var debouncer = new ControlValueDebouncer();
        var emitted = debouncer.ShouldEmitNow("lights.beacon", true, debounceMs: 100, _ => { });

        Assert.True(emitted);
    }

    [Fact]
    public void SameValueAgain_NeverEmits()
    {
        var debouncer = new ControlValueDebouncer();
        debouncer.ShouldEmitNow("lights.beacon", true, 100, _ => { });

        var emittedAgain = debouncer.ShouldEmitNow("lights.beacon", true, 100, _ => { });

        Assert.False(emittedAgain);
    }

    [Fact]
    public void ChangeWithinDebounceWindow_IsDeferredThenSentLater()
    {
        var debouncer = new ControlValueDebouncer();
        debouncer.ShouldEmitNow("lights.beacon", false, 200, _ => { });

        object? deferredValue = null;
        var resetEvent = new ManualResetEventSlim(false);

        var emittedNow = debouncer.ShouldEmitNow("lights.beacon", true, 200, v =>
        {
            deferredValue = v;
            resetEvent.Set();
        });

        Assert.False(emittedNow);

        var signaled = resetEvent.Wait(TimeSpan.FromSeconds(2));
        Assert.True(signaled, "El valor diferido debía emitirse tras la ventana de debounce.");
        Assert.Equal(true, deferredValue);
    }

    [Fact]
    public void ZeroDebounce_AlwaysEmitsImmediatelyOnChange()
    {
        var debouncer = new ControlValueDebouncer();
        debouncer.ShouldEmitNow("flight.flaps", 0.0, 0, _ => { });

        var emitted = debouncer.ShouldEmitNow("flight.flaps", 10.0, 0, _ => { });

        Assert.True(emitted);
    }
}
