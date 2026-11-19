<?php

declare(strict_types=1);

namespace Drupal\Tests\example\Unit;

use Drupal\Component\Utility\Html;
use Drupal\Tests\UnitTestCase;
use PHPUnit\Framework\Attributes\Group;

/**
 * Verifies that the Drupal unit test bootstrap loads core utilities.
 */
#[Group('example')]
final class ExampleUnitTest extends UnitTestCase {

  /**
   * Tests escaping text that contains markup.
   */
  public function testEscapeMarkup(): void {
    self::assertSame('&lt;example&gt;', Html::escape('<example>'));
  }

}
