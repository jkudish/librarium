<?php

declare(strict_types=1);

use Firecrawl\Laravel\FirecrawlServiceProvider;
use Jkudish\LaravelAiLibrarium\Facades\Librarium;
use Jkudish\LaravelAiLibrarium\LaravelAiLibrariumServiceProvider;
use Jkudish\LaravelAiLibrariumFirecrawl\FirecrawlDriver;
use Jkudish\LaravelAiLibrariumFirecrawl\FirecrawlLibrariumServiceProvider;
use Orchestra\Testbench\TestCase;

require_once __DIR__.'/provider-values.php';

const MAX_ANSWER_CHARACTERS = 20000;
const MAX_CITATIONS = 20;

function respond(array $payload): never
{
    fwrite(STDOUT, json_encode($payload, JSON_THROW_ON_ERROR | JSON_UNESCAPED_SLASHES));
    exit(0);
}

function fail(string $message): never
{
    $secrets = array_values(array_filter([
        getenv('SEARCHAPI_API_KEY') ?: null,
        getenv('FIRECRAWL_API_KEY') ?: null,
    ], fn ($value): bool => is_string($value) && $value !== ''));
    $safeMessage = mb_substr(str_replace($secrets, '[REDACTED]', $message), 0, 500);
    $failurePath = getenv('SURFACE_CALIBRATION_FAILURE_PATH');
    if (is_string($failurePath) && $failurePath !== '') {
        file_put_contents($failurePath, json_encode([
            'schemaVersion' => 1,
            'error' => $safeMessage,
        ], JSON_THROW_ON_ERROR | JSON_UNESCAPED_SLASHES), LOCK_EX);
    }
    respond(['ok' => false, 'error' => $safeMessage]);
}

function boundedString(mixed $value, int $maximum): ?string
{
    return is_string($value) && $value !== '' ? mb_substr($value, 0, $maximum) : null;
}

$input = json_decode(stream_get_contents(STDIN), true, flags: JSON_THROW_ON_ERROR);
$operation = $input['operation'] ?? null;
$providerId = $input['providerId'] ?? '';
$source = $input['sourceOptions'] ?? [];

if ($operation === 'describe') {
    respond([
        'ok' => true,
        'data' => [
            'id' => $providerId,
            'displayName' => "PHP Librarium {$source['collector']} {$source['surface']}",
            'tier' => 'ai-grounded',
            'execution' => 'inline',
            'envVar' => $source['collector'] === 'firecrawl' ? 'FIRECRAWL_API_KEY' : 'SEARCHAPI_API_KEY',
            'requiresApiKey' => true,
            'capabilities' => ['execute' => true],
        ],
    ]);
}

if ($operation !== 'execute') {
    fail("Unsupported operation: {$operation}");
}

require __DIR__.'/vendor/autoload.php';

final class SurfaceCalibrationApplication extends TestCase
{
    public function boot(): void
    {
        parent::setUp();
    }

    protected function getPackageProviders($app): array
    {
        return [
            LaravelAiLibrariumServiceProvider::class,
            FirecrawlServiceProvider::class,
            FirecrawlLibrariumServiceProvider::class,
        ];
    }

    protected function defineEnvironment($app): void
    {
        $config = $app['config'];
        $config->set('cache.default', 'array');
        $config->set('services.searchapi.key', getenv('SEARCHAPI_API_KEY') ?: null);
        $config->set('firecrawl.api_key', getenv('FIRECRAWL_API_KEY') ?: null);
        $config->set('firecrawl-librarium.register_profile', true);
        $config->set('firecrawl-librarium.profile_id', 'firecrawl-chatgpt');
        $config->set('firecrawl-librarium.profile', [
            'driver' => FirecrawlDriver::class,
            'provider' => 'firecrawl',
            'model' => null,
            'result_kind' => 'grounded_answer',
            'grounding' => 'optional',
            'observation' => 'surface_snapshot',
            'corpora' => ['web'],
            'retrieval_methods' => ['research_agent'],
            'prompt' => '{{ query }}',
            'enabled' => true,
            'options' => [
                'mode' => 'interact',
                'target_url' => 'https://chatgpt.com/',
                'surface' => 'chatgpt-web',
                'authentication' => 'anonymous',
                'locale' => 'en-CA',
                'country' => 'CA',
                'device' => 'desktop',
                'personalization' => 'unknown',
                'account_context' => 'signed_out',
            ],
            'credential' => null,
        ]);
    }
}

try {
    $application = new SurfaceCalibrationApplication('surfaceCalibration');
    $application->boot();
    $started = hrtime(true);
    $response = Librarium::query((string) ($input['query'] ?? ''))
        ->using((string) ($source['profile'] ?? ''))
        ->timeout((int) ($input['options']['timeout'] ?? 180))
        ->run();
    $durationMs = (hrtime(true) - $started) / 1_000_000;

    if ($response->status->value !== 'succeeded' || $response->results->count() !== 1) {
        $errors = $response->errors->map(fn ($error): string => "{$error->code}: {$error->message}")->all();
        fail($errors === [] ? 'PHP Librarium returned no single successful result' : implode('; ', $errors));
    }

    $result = $response->results->sole();
    if (! is_string($result->content)) {
        fail('PHP Librarium returned non-text consumer content');
    }
    $citations = $result->citations
        ->filter(fn ($citation): bool => is_string($citation->source->url) && $citation->source->url !== '')
        ->take(MAX_CITATIONS)
        ->map(function ($citation) use ($providerId): array {
            return [
                'url' => boundedString($citation->source->url, 2048),
                'title' => boundedString($citation->source->title, 500),
                'snippet' => boundedString($citation->excerpt, 1000),
                'provider' => $providerId,
            ];
        })->values()->all();
    $providerMeta = $result->providerMeta === null ? [] : (array) $result->providerMeta;
    $rawContext = (array) ($result->provenance->context ?? []);
    $context = array_intersect_key($rawContext, array_flip(['locale', 'country', 'device', 'authentication']));
    $rawDeclaredContext = (array) ($providerMeta['consumer_declared_context'] ?? []);
    $declaredContext = array_intersect_key($rawDeclaredContext, array_flip(['personalization', 'account_context']));
    $operationReceipt = surfaceCalibrationOperationReceipt($providerMeta['operation_receipt'] ?? null);
    $creditsUsed = surfaceCalibrationCreditsUsed($providerMeta['credits_used'] ?? null);
    $evidenceReceipts = array_slice(array_values(array_filter(array_map(
        function ($receipt): ?array {
            if (! is_array($receipt)) {
                return null;
            }

            return array_filter([
                'kind' => boundedString($receipt['kind'] ?? null, 50),
                'reference_sha256' => preg_match('/^[a-f0-9]{64}$/', (string) ($receipt['reference_sha256'] ?? '')) === 1
                    ? $receipt['reference_sha256']
                    : null,
                'reference_state' => in_array($receipt['reference_state'] ?? null, ['retained', 'redacted'], true)
                    ? $receipt['reference_state']
                    : null,
                'reference' => boundedString($receipt['reference'] ?? null, 2048),
            ], fn ($value): bool => $value !== null);
        },
        (array) ($providerMeta['evidence_receipts'] ?? []),
    ))), 0, 10);
    $actualCostUsd = $result->usage?->currency === 'USD' && $result->usage->actualCost !== null
        ? (float) $result->usage->actualCost
        : null;
    $envelope = [
        'schemaVersion' => 1,
        'answer' => mb_substr($result->content, 0, MAX_ANSWER_CHARACTERS),
        'completion' => true,
        'provenance' => [
            'requestedProfile' => $result->requestedProfile,
            'profile' => $result->profile,
            'provider' => $result->provider,
            'collector' => $result->provenance->collector,
            'surface' => $result->provenance->surface,
            'context' => $context,
            'consumerDeclaredContext' => $declaredContext,
        ],
        'challenge' => $providerMeta['challenge'] ?? ($source['collector'] === 'firecrawl' ? 'unknown' : 'not-reported'),
        'loginWall' => (bool) ($providerMeta['login_wall'] ?? false),
        'reportedLatencyMs' => $providerMeta['latency_ms'] ?? null,
        'usage' => [
            'creditsUsed' => $creditsUsed,
            'costUsd' => $actualCostUsd,
            'costKind' => $actualCostUsd === null ? null : 'actual',
        ],
        'receipt' => [
            'requestId' => boundedString($response->requestId, 200),
            'providerRequestId' => boundedString($providerMeta['request_id'] ?? null, 200),
            'evidenceReceipts' => $evidenceReceipts,
            'operationReceipt' => $operationReceipt,
        ],
    ];

    respond([
        'ok' => true,
        'data' => [
            'provider' => $providerId,
            'tier' => 'ai-grounded',
            'content' => json_encode($envelope, JSON_THROW_ON_ERROR | JSON_UNESCAPED_SLASHES),
            'citations' => $citations,
            'durationMs' => $durationMs,
            'model' => $result->model ?: null,
        ],
    ]);
} catch (Throwable $error) {
    fail($error->getMessage());
}
