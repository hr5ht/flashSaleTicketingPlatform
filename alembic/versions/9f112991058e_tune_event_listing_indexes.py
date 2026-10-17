from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = '9f112991058e'
down_revision: str | None = '5c8f1bbb632f'
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.drop_index(op.f('ix_events_city_lower'), table_name='events')
    op.create_index('ix_events_status_city_starts_at', 'events', ['status', sa.literal_column('lower(city)'), 'starts_at'], unique=False)


def downgrade() -> None:
    op.drop_index('ix_events_status_city_starts_at', table_name='events')
    op.create_index(op.f('ix_events_city_lower'), 'events', [sa.literal_column('lower(city)')], unique=False)
