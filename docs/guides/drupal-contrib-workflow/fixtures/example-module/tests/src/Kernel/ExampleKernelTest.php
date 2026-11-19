<?php

declare(strict_types=1);

namespace Drupal\Tests\example\Kernel;

use Drupal\KernelTests\KernelTestBase;
use PHPUnit\Framework\Attributes\Group;
use PHPUnit\Framework\Attributes\RunTestsInSeparateProcesses;

/**
 * Verifies that the module can boot against the recipe database.
 */
#[Group('example')]
#[RunTestsInSeparateProcesses]
final class ExampleKernelTest extends KernelTestBase {

  /**
   * {@inheritdoc}
   */
  protected static $modules = ['example'];

  /**
   * Tests that the kernel can query the database.
   */
  public function testDatabaseConnection(): void {
    $database = $this->container->get('database');
    self::assertSame(1, (int) $database->query('SELECT 1')->fetchField());
  }

}
