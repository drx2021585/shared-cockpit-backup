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

## Estado actual de la implementación (server/api)

`server/api/src/db.ts` implementa una versión simplificada de este esquema
(sin tabla `users` todavía — las sesiones identifican pilotos por nombre, no
por cuenta) contra **PostgreSQL real, vía `pg` y `DATABASE_URL`** (por ejemplo,
una instancia de Supabase). No hay SQL Server, no hay SQLite y no hay mock en
memoria: si `DATABASE_URL` no está definida, el servidor falla al arrancar con
un error explícito en vez de degradar silenciosamente.

Este cambio (antes usaba SQLite local vía `node:sqlite`, un archivo por
máquina) fue necesario porque cada piloto corriendo su propio servidor local
significaba que un amigo uniéndose con un código de sesión nunca veía la
sesión creada en la máquina del host — SQLite es de un solo archivo/una sola
máquina, no compartible entre dos redes distintas. En producción debe existir
una única instancia del servidor (`server/api`) desplegada (por ejemplo, en
Railway) apuntando a la misma base de datos compartida, para que ambos pilotos
se conecten al mismo proceso y vean la misma sesión. Para desarrollo local
individual sigue siendo válido apuntar `DATABASE_URL` a una base de datos
Postgres local o a un proyecto de Supabase de pruebas.
