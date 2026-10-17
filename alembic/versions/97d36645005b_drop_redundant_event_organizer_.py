from collections.abc import Sequence

from alembic import op

revision: str = '97d36645005b'
down_revision: str | None = '9f112991058e'
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.drop_constraint(op.f('uq_events_id_organizer'), 'events', type_='unique')


def downgrade() -> None:
    op.create_unique_constraint(op.f('uq_events_id_organizer'), 'events', ['id', 'organizer_id'], postgresql_nulls_not_distinct=False)
