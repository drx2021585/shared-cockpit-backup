using SharedCockpit.Bridge.Profiles;
using Xunit;

namespace SimulatorBridge.Tests;

public class ProfileMatcherTests
{
    private static AircraftProfile MakeProfile(string id, IEnumerable<string> titleContains, bool fallback = true)
    {
        return new AircraftProfile
        {
            ProfileId = id,
            Manifest = new AircraftManifest(),
            Detection = new DetectionRule
            {
                TitleContains = titleContains.ToList(),
                FallbackToPartialMatch = fallback,
            },
            Controls = Array.Empty<ControlDefinition>(),
        };
    }

    [Fact]
    public void ExactSubstringMatch_PicksCorrectProfile()
    {
        var ifly = MakeProfile("ifly-737-max8", new[] { "iFly 737 MAX 8", "737 MAX" });
        var pmdg = MakeProfile("pmdg-737-900", new[] { "PMDG 737-900", "PMDG 737-900ER" });

        var result = ProfileMatcher.Match(new[] { ifly, pmdg }, "iFly 737 MAX 8 Ryanair");

        Assert.NotNull(result.Profile);
        Assert.Equal("ifly-737-max8", result.Profile!.ProfileId);
        Assert.False(result.IsPartialMatch);
    }

    [Fact]
    public void MatchIsCaseInsensitive()
    {
        var ifly = MakeProfile("ifly-737-max8", new[] { "iFly 737 MAX 8" });

        var result = ProfileMatcher.Match(new[] { ifly }, "ifly 737 max 8 ryanair");

        Assert.NotNull(result.Profile);
        Assert.Equal("ifly-737-max8", result.Profile!.ProfileId);
    }

    [Fact]
    public void NoMatch_ReturnsNullProfile_DoesNotGuess()
    {
        var ifly = MakeProfile("ifly-737-max8", new[] { "iFly 737 MAX 8" }, fallback: false);

        var result = ProfileMatcher.Match(new[] { ifly }, "Airbus A320 Neo FlyByWire");

        Assert.Null(result.Profile);
    }

    [Fact]
    public void FallbackToPartialMatch_OnlyAppliesWhenFlagIsTrue()
    {
        var pmdgNoFallback = MakeProfile("pmdg-737-900", new[] { "PMDG 737-900" }, fallback: false);

        // Título parcial: contiene "737-900" pero no el string exacto "PMDG 737-900".
        var result = ProfileMatcher.Match(new[] { pmdgNoFallback }, "Boeing 737-900 generic livery");

        Assert.Null(result.Profile);
    }

    [Fact]
    public void FallbackToPartialMatch_MatchesOnSharedWord_WhenAllowed()
    {
        var pmdg = MakeProfile("pmdg-737-900", new[] { "PMDG 737-900" }, fallback: true);

        var result = ProfileMatcher.Match(new[] { pmdg }, "PMDG 737-900ER Southwest livery");

        Assert.NotNull(result.Profile);
        Assert.Equal("pmdg-737-900", result.Profile!.ProfileId);
    }

    [Fact]
    public void EmptyTitle_NeverMatches()
    {
        var ifly = MakeProfile("ifly-737-max8", new[] { "iFly 737 MAX 8" });

        var result = ProfileMatcher.Match(new[] { ifly }, "");

        Assert.Null(result.Profile);
    }
}
