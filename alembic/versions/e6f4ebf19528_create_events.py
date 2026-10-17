from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = 'e6f4ebf19528'
down_revision: str | None = 'c281d283c4b2'
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


event_category = sa.Enum(
    "concert", "sports", "theatre", "conference", "festival", name="event_category"
)
event_status = sa.Enum("draft", "published", name="event_status")


def upgrade() -> None:
    op.create_table('events',
    sa.Column('id', sa.BigInteger(), sa.Identity(always=False), nullable=False),
    sa.Column('organizer_id', sa.UUID(), nullable=False),
    sa.Column('title', sa.Text(), nullable=False),
    sa.Column('description', sa.Text(), nullable=False),
    sa.Column('category', sa.Enum('concert', 'sports', 'theatre', 'conference', 'festival', name='event_category'), nullable=False),
    sa.Column('city', sa.Text(), nullable=False),
    sa.Column('venue', sa.Text(), nullable=False),
    sa.Column('starts_at', sa.DateTime(timezone=True), nullable=False),
    sa.Column('sale_starts_at', sa.DateTime(timezone=True), nullable=False),
    sa.Column('status', sa.Enum('draft', 'published', name='event_status'), server_default='draft', nullable=False),
    sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.CheckConstraint('sale_starts_at <= starts_at', name='ck_events_sale_before_start'),
    sa.ForeignKeyConstraint(['organizer_id'], ['users.id'], ondelete='CASCADE'),
    sa.PrimaryKeyConstraint('id'),
    sa.UniqueConstraint('id', 'organizer_id', name='uq_events_id_organizer')
    )
    op.create_index('ix_events_city_lower', 'events', [sa.literal_column('lower(city)')], unique=False)
    op.create_index('ix_events_organizer_id', 'events', ['organizer_id'], unique=False)
    op.create_index('ix_events_status_category_starts_at', 'events', ['status', 'category', 'starts_at'], unique=False)
    op.create_index('ix_events_status_starts_at', 'events', ['status', 'starts_at'], unique=False)
    op.create_table('price_tiers',
    sa.Column('id', sa.BigInteger(), sa.Identity(always=False), nullable=False),
    sa.Column('event_id', sa.BigInteger(), nullable=False),
    sa.Column('name', sa.Text(), nullable=False),
    sa.Column('price_cents', sa.Integer(), nullable=False),
    sa.CheckConstraint('price_cents > 0', name='ck_price_tiers_price_positive'),
    sa.ForeignKeyConstraint(['event_id'], ['events.id'], ondelete='CASCADE'),
    sa.PrimaryKeyConstraint('id'),
    sa.UniqueConstraint('event_id', 'name', name='uq_price_tiers_event_name'),
    sa.UniqueConstraint('id', 'event_id', name='uq_price_tiers_id_event')
    )
    op.create_table('sections',
    sa.Column('id', sa.BigInteger(), sa.Identity(always=False), nullable=False),
    sa.Column('event_id', sa.BigInteger(), nullable=False),
    sa.Column('name', sa.Text(), nullable=False),
    sa.ForeignKeyConstraint(['event_id'], ['events.id'], ondelete='CASCADE'),
    sa.PrimaryKeyConstraint('id'),
    sa.UniqueConstraint('event_id', 'name', name='uq_sections_event_name'),
    sa.UniqueConstraint('id', 'event_id', name='uq_sections_id_event')
    )
    op.create_table('seats',
    sa.Column('id', sa.BigInteger(), sa.Identity(always=False), nullable=False),
    sa.Column('event_id', sa.BigInteger(), nullable=False),
    sa.Column('section_id', sa.BigInteger(), nullable=False),
    sa.Column('price_tier_id', sa.BigInteger(), nullable=False),
    sa.Column('row_label', sa.Text(), nullable=False),
    sa.Column('seat_number', sa.Integer(), nullable=False),
    sa.ForeignKeyConstraint(['price_tier_id', 'event_id'], ['price_tiers.id', 'price_tiers.event_id'], name='fk_seats_price_tier_event', ondelete='CASCADE'),
    sa.ForeignKeyConstraint(['section_id', 'event_id'], ['sections.id', 'sections.event_id'], name='fk_seats_section_event', ondelete='CASCADE'),
    sa.PrimaryKeyConstraint('id'),
    sa.UniqueConstraint('section_id', 'row_label', 'seat_number', name='uq_seats_section_row_number')
    )
    op.create_index('ix_seats_event_id', 'seats', ['event_id'], unique=False)


def downgrade() -> None:
    op.drop_index('ix_seats_event_id', table_name='seats')
    op.drop_table('seats')
    op.drop_table('sections')
    op.drop_table('price_tiers')
    op.drop_index('ix_events_status_starts_at', table_name='events')
    op.drop_index('ix_events_status_category_starts_at', table_name='events')
    op.drop_index('ix_events_organizer_id', table_name='events')
    op.drop_index('ix_events_city_lower', table_name='events')
    op.drop_table('events')
    event_status.drop(op.get_bind())
    event_category.drop(op.get_bind())
