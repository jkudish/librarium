<?php

declare(strict_types=1);

/** @return array{mode: string, stage: string, cleanup: string, providerOperationsStarted: int}|null */
function surfaceCalibrationOperationReceipt(mixed $value): ?array
{
    if (! is_array($value)
        || ! in_array($value['mode'] ?? null, ['interact', 'agent'], true)
        || ($value['stage'] ?? null) !== 'observation'
        || ! in_array($value['cleanup'] ?? null, ['completed', 'failed', 'not_started', 'not_applicable'], true)
        || ! is_int($value['provider_operations_started'] ?? null)
        || $value['provider_operations_started'] < 0
        || $value['provider_operations_started'] > 10_000) {
        return null;
    }

    return [
        'mode' => $value['mode'],
        'stage' => $value['stage'],
        'cleanup' => $value['cleanup'],
        'providerOperationsStarted' => $value['provider_operations_started'],
    ];
}

function surfaceCalibrationCreditsUsed(mixed $value): ?int
{
    return is_int($value) && $value >= 0 && $value <= 2_147_483_647 ? $value : null;
}
