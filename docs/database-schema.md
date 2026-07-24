# Esquema de base de datos inicial (PostgreSQL)

Dueño: networking-agent. Ver sección 18 del plan maestro original.

```sql
CREATE TABLE users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    display_name TEXT NOT NULL,
    email TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_seen_at TIMESTAMPTZ
);

CREATE TABLE aircraft_profiles (
    id TEXT PRIMARY KEY,               -- ej. 'cessna-172'
    name TEXT NOT NULL,
    developer TEXT NOT NULL,
    version TEXT NOT NULL,
    schema_version INT NOT NULL,
    coverage JSONB,                    -- snapshot de capabilities.yaml
    verified BOOLEAN NOT NULL DEFAULT false,
    download_url TEXT
);

CREATE TABLE sessions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    join_code TEXT UNIQUE NOT NULL,
    host_user_id UUID NOT NULL REFERENCES users(id),
    aircraft_profile_id TEXT NOT NULL REFERENCES aircraft_profiles(id),
    simulator_version TEXT NOT NULL,   -- 'msfs2020' | 'msfs2024'
    status TEXT NOT NULL DEFAULT 'active',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    ended_at TIMESTAMPTZ
);

CREATE TABLE session_participants (
    session_id UUID NOT NULL REFERENCES sessions(id),
    user_id UUID NOT NULL REFERENCES users(id),
    role TEXT NOT NULL,                -- 'captain' | 'first_officer' | 'observer'
    authority TEXT,
    joined_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    disconnected_at TIMESTAMPTZ,
    PRIMARY KEY (session_id, user_id)
);

CREATE TABLE sync_reports (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    session_id UUID NOT NULL REFERENCES sessions(id),
    aircraft_profile_id TEXT NOT NULL REFERENCES aircraft_profiles(id),
    control_id TEXT NOT NULL,
    error_type TEXT NOT NULL,
    client_version TEXT NOT NULL,
    simulator_version TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

Redis se usa para estado efímero de sesiones activas y presencia (no persistente),
no para el histórico — eso vive en PostgreSQL.
