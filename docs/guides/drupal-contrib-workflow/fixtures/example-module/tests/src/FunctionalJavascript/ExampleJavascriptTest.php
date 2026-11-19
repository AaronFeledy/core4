<?php

declare(strict_types=1);

namespace Drupal\Tests\example\FunctionalJavascript;

use Drupal\FunctionalJavascriptTests\WebDriverTestBase;
use PHPUnit\Framework\Attributes\Group;
use PHPUnit\Framework\Attributes\RunTestsInSeparateProcesses;

/**
 * Verifies that browser tests reach the site through headless Chrome.
 */
#[Group('example')]
#[RunTestsInSeparateProcesses]
final class ExampleJavascriptTest extends WebDriverTestBase {

  /**
   * {@inheritdoc}
   */
  protected static $modules = ['example'];

  /**
   * {@inheritdoc}
   */
  protected $defaultTheme = 'stark';

  /**
   * Tests that Chrome renders the login form.
   */
  public function testLoginForm(): void {
    $this->drupalGet('user/login');
    $this->assertSession()->waitForElementVisible('css', 'input[name="name"]');
    $this->assertSession()->fieldExists('name');
  }

}
