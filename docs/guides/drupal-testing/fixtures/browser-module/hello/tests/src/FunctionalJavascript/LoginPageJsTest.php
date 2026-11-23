<?php

declare(strict_types=1);

namespace Drupal\Tests\hello\FunctionalJavascript;

use Drupal\FunctionalJavascriptTests\WebDriverTestBase;
use PHPUnit\Framework\Attributes\Group;
use PHPUnit\Framework\Attributes\RunTestsInSeparateProcesses;

#[Group('hello')]
#[RunTestsInSeparateProcesses]
final class LoginPageJsTest extends WebDriverTestBase {

  protected $defaultTheme = 'stark';

  public function testLoginPageInChrome(): void {
    $this->drupalGet('user/login');
    $this->assertNotNull($this->assertSession()->waitForElementVisible('css', 'input[name="name"]'));
    $this->assertStringContainsString('Chrome', $this->getSession()->evaluateScript('navigator.userAgent'));
  }

}
