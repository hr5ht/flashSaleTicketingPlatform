from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = '5c8f1bbb632f'
down_revision: str | None = 'e6f4ebf19528'
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


hold_status = sa.Enum("active", "released", "confirmed", name="hold_status")


def upgrade() -> None:
    op.create_table('holds',
    sa.Column('id', sa.BigInteger(), sa.Identity(always=False), nullable=False),
    sa.Column('event_id', sa.BigInteger(), nullable=False),
    sa.Column('user_id', sa.UUID(), nullable=False),
    sa.Column('status', sa.Enum('active', 'released', 'confirmed', name='hold_status'), server_default='active', nullable=False),
    sa.Column('expires_at', sa.DateTime(timezone=True), nullable=False),
    sa.Column('idempotency_key', sa.Text(), nullable=True),
    sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.ForeignKeyConstraint(['event_id'], ['events.id'], ondelete='CASCADE'),
    sa.ForeignKeyConstraint(['user_id'], ['users.id'], ondelete='CASCADE'),
    sa.PrimaryKeyConstraint('id'),
    sa.UniqueConstraint('user_id', 'idempotency_key', name='uq_holds_user_idempotency_key')
    )
    op.create_index('ix_holds_event_user', 'holds', ['event_id', 'user_id'], unique=False)
    op.create_index('ix_holds_status_expires_at', 'holds', ['status', 'expires_at'], unique=False)
    op.create_table('bookings',
    sa.Column('id', sa.BigInteger(), sa.Identity(always=False), nullable=False),
    sa.Column('event_id', sa.BigInteger(), nullable=False),
    sa.Column('user_id', sa.UUID(), nullable=False),
    sa.Column('hold_id', sa.BigInteger(), nullable=False),
    sa.Column('total_cents', sa.Integer(), nullable=False),
    sa.Column('idempotency_key', sa.Text(), nullable=True),
    sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.CheckConstraint('total_cents > 0', name='ck_bookings_total_positive'),
    sa.ForeignKeyConstraint(['event_id'], ['events.id'], ondelete='CASCADE'),
    sa.ForeignKeyConstraint(['hold_id'], ['holds.id'], ondelete='CASCADE'),
    sa.ForeignKeyConstraint(['user_id'], ['users.id'], ondelete='CASCADE'),
    sa.PrimaryKeyConstraint('id'),
    sa.UniqueConstraint('hold_id', name='uq_bookings_hold'),
    sa.UniqueConstraint('user_id', 'idempotency_key', name='uq_bookings_user_idempotency_key')
    )
    op.create_index('ix_bookings_event_id', 'bookings', ['event_id'], unique=False)
    op.create_index('ix_bookings_user_id', 'bookings', ['user_id'], unique=False)
    op.create_table('seat_claims',
    sa.Column('seat_id', sa.BigInteger(), nullable=False),
    sa.Column('hold_id', sa.BigInteger(), nullable=False),
    sa.ForeignKeyConstraint(['hold_id'], ['holds.id'], ondelete='CASCADE'),
    sa.ForeignKeyConstraint(['seat_id'], ['seats.id'], ondelete='CASCADE'),
    sa.PrimaryKeyConstraint('seat_id')
    )
    op.create_index('ix_seat_claims_hold_id', 'seat_claims', ['hold_id'], unique=False)


def downgrade() -> None:
    op.drop_index('ix_seat_claims_hold_id', table_name='seat_claims')
    op.drop_table('seat_claims')
    op.drop_index('ix_bookings_user_id', table_name='bookings')
    op.drop_index('ix_bookings_event_id', table_name='bookings')
    op.drop_table('bookings')
    op.drop_index('ix_holds_status_expires_at', table_name='holds')
    op.drop_index('ix_holds_event_user', table_name='holds')
    op.drop_table('holds')
    hold_status.drop(op.get_bind())
