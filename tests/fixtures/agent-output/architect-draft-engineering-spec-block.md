Here's the engineering spec for onboarding. Data model first.

DRAFT_ENGINEERING_SPEC_START
# Feature: Onboarding — Engineering Spec

## Data Model

**users table** (extends existing)
- `id` uuid PK
- `email` text UNIQUE NOT NULL
- `password_hash` text NOT NULL
- `created_at` timestamptz DEFAULT now()
- `onboarding_completed_at` timestamptz NULLABLE

**health_profiles table** (new)
- `id` uuid PK
- `user_id` uuid FK → users.id
- `date_of_birth` date NOT NULL
- `biological_sex` text NOT NULL -- 'male' | 'female' | 'prefer_not_to_say'
- `height_cm` int NULLABLE
- `weight_kg` decimal NULLABLE
- `created_at` timestamptz DEFAULT now()
- `updated_at` timestamptz DEFAULT now()

## API Surface

**POST /auth/register**
Body: `{ email, password }`
Response: `{ userId, token }`

**POST /auth/login**
Body: `{ email, password }`
Response: `{ userId, token }`

**POST /health-profiles**
Auth: required
Body: `{ dateOfBirth, biologicalSex, heightCm?, weightKg? }`
Response: `{ profileId }`

## Open Questions
- [type: engineering] [blocking: yes] Should tokens be JWTs (stateless) or opaque tokens with server-side sessions?
- [type: product] [blocking: no] Is height/weight required or optional?
DRAFT_ENGINEERING_SPEC_END

One blocking question before we go further: JWT vs session tokens.
