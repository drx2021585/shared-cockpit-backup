namespace SharedCockpit.Bridge.Profiles;

public sealed record ProfileMatchResult(AircraftProfile? Profile, bool IsPartialMatch, string DetectedTitle);

/// <summary>
/// Decide qué perfil aplica para el título de aeronave actualmente cargado en
/// MSFS, siguiendo aircraft-profiles/&lt;id&gt;/detection.yaml (`titleContains` +
/// `fallbackToPartialMatch`). Si ningún perfil calza, el bridge debe reportarlo
/// explícitamente (nunca asumir un perfil por defecto silenciosamente).
/// </summary>
public static class ProfileMatcher
{
    public static ProfileMatchResult Match(IReadOnlyList<AircraftProfile> profiles, string detectedTitle)
    {
        if (string.IsNullOrWhiteSpace(detectedTitle))
        {
            return new ProfileMatchResult(null, false, detectedTitle);
        }

        // Paso 1: match exacto por substring contra cualquier titleContains (case-insensitive,
        // porque el título expuesto por SimConnect puede variar en capitalización entre versiones).
        foreach (var profile in profiles)
        {
            foreach (var candidate in profile.Detection.TitleContains)
            {
                if (detectedTitle.Contains(candidate, StringComparison.OrdinalIgnoreCase))
                {
                    return new ProfileMatchResult(profile, false, detectedTitle);
                }
            }
        }

        // Paso 2: fallback parcial solo si el perfil lo permite explícitamente
        // (fallbackToPartialMatch: true) — compara por palabras sueltas del
        // titleContains contra el título detectado.
        foreach (var profile in profiles)
        {
            if (!profile.Detection.FallbackToPartialMatch)
            {
                continue;
            }

            foreach (var candidate in profile.Detection.TitleContains)
            {
                var words = candidate.Split(' ', StringSplitOptions.RemoveEmptyEntries);
                if (words.Any(word => word.Length >= 3 && detectedTitle.Contains(word, StringComparison.OrdinalIgnoreCase)))
                {
                    return new ProfileMatchResult(profile, true, detectedTitle);
                }
            }
        }

        return new ProfileMatchResult(null, false, detectedTitle);
    }
}
