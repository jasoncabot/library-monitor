import { SendEmail } from "@cloudflare/workers-types";
import { EmailMessage } from "cloudflare:email";
import { createMimeMessage } from "mimetext";
import { parseString } from "set-cookie-parser";

export interface Env {
  BORROWER_ID: string;
  BORROWER_PASSWORD: string;
  EMAIL: SendEmail;
}

interface Book {
  id: string | null;
  title: string;
  due: string;
  status: string;
}

const checkForOverdueBooks = async (
  alwaysSend: boolean,
  borrowerId: string,
  password: string,
  mailer: SendEmail
) => {
  const rdt = encodeURIComponent(
    "/cgi-bin/spydus.exe/PGM/WPAC/CCOPT/LB/1?ISGLB=0"
  );

  try {
    // Login to spydus
    console.log(`Logging in with Borrower ID ${borrowerId}`);
    const result = await fetch(
      "https://wokingham.spydus.co.uk/cgi-bin/spydus.exe/PGM/WPAC/CCOPT/LB/2",
      {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: `BRWLID=${borrowerId}&BRWLPWD=${password}&RDT=${rdt}`,
      }
    );

    // Find the cookie we need to send with every other request
    const cookie = result.headers.get("set-cookie")!;
    const value = (parseString(cookie) as any)[", spydus_brwsessionid_443"];
    console.log(`Logged in, setting SPYDUS_BRWSESSIONID_443=${value}`);

    // Load the dashboard
    const loginResponse = await result.text();
    const dashLink = (new RegExp(/(https[^"]+)"/).exec(loginResponse) || [
      "",
      "",
    ])[1];

    // Check home page for link to the main dashboard
    console.log(`Loading dashboard from ${dashLink}`);
    let dashResponse = await fetch(dashLink, {
      headers: { cookie: `SPYDUS_BRWSESSIONID_443=${value}` },
    });

    const urls = await extractLoanUrls(dashResponse);
    console.log(`Found ${urls.length} loan url(s) on dashboard`);

    const books: Book[] = (
      await Promise.all(
        urls.map(async (url) => await findBooksOnLoan(url, value))
      )
    ).flat();

    // find any books past or nearing renewal date
    const now = new Date();
    const notify = books.filter((book) => {
      const dueAt = Date.parse(book.due);
      console.log(
        `${book.title} is due ${book.due} with status ${book.status}...`
      );
      let difference = dueAt - now.getTime();
      return alwaysSend || difference < 172800000;
    }) as Book[];

    console.log(`Found ${notify.length} overdue books out of ${books.length}`);

    // 2. If any are overdue
    if (notify.length > 0) {
      const text = notify
        .map(
          (book) =>
            `* ${book.title} is due ${book.due} and has status: ${book.status}.`
        )
        .join("\n");

      // send email
      try {
        await sendEmail(mailer, notify, text);
        console.log("sent email");
      } catch (error: any) {
        console.error("Error sending email: " + error.message);
        return error
      }

    }
    return "done";
  } catch (error: any) {
    return error.message;
  }
};

export default {
  async fetch(request: Request, env: Env) {
    const alwaysSend = request.url.includes("alwaysSend=true");
    const response = await checkForOverdueBooks(
      alwaysSend,
      env.BORROWER_ID,
      env.BORROWER_PASSWORD,
      env.EMAIL
    );
    return new Response(response, { status: 200 });
  },

  async scheduled(
    controller: ScheduledController,
    env: Env,
    ctx: ExecutionContext
  ): Promise<void> {
    await checkForOverdueBooks(
      false,
      env.BORROWER_ID,
      env.BORROWER_PASSWORD,
      env.EMAIL
    );
  },
};

async function sendEmail(mailer: SendEmail, overdue: Book[], content: string) {
  const messages = [
    { name: "Jason Cabot", addr: "jasoncabot@gmail.com" },
    { name: "Kirsty Cabot", addr: "kirstycabot@gmail.com" },
  ].map((r) => {
    const msg = createMimeMessage();
    const sendingAddress = "no-reply@jasoncabot.me";
    msg.setSender({ name: "Library Monitor", addr: sendingAddress });
    msg.setRecipient({ name: r.name, addr: r.addr });
    msg.setSubject(
      `${overdue.length} ${
        overdue.length === 1 ? "book" : "books"
      } near renewal date`
    );
    msg.addMessage({
      contentType: "text/plain",
      data: content,
    });

    return mailer.send(new EmailMessage(sendingAddress, r.addr, msg.asRaw()));
  });

  return Promise.all(messages);
}

async function extractLoanUrls(dashResponse: Response): Promise<string[]> {
  // find the href value of all anchor tags with class brw-dashboard-item
  const urls: string[] = [];
  const rewriter = new HTMLRewriter()
    .on(`a.brw-dashboard-item`, {
      element(e: Element) {
        const href = e.getAttribute("href");
        if (href) {
          urls.push(href);
        }
      },
    })
    .transform(dashResponse);
  await rewriter.text();

  return urls;
}

async function findBooksOnLoan(url: string, value: any): Promise<Book[]> {
  const loansPath = url
    .replaceAll("&amp;", "&")
    .replaceAll("&lt;", "%3C")
    .replaceAll("&gt;", "%3E");
  const loansURL = "https://wokingham.spydus.co.uk" + loansPath;

  console.log("Finding all loans from " + loansURL);
  const spydusResponse = await fetch(loansURL, {
    headers: { cookie: `SPYDUS_BRWSESSIONID_443=${value}` },
  });

  const books: Book[] = [];
  const rewriter = new HTMLRewriter()
    .on(`input[name=SVL]`, {
      element(e: Element) {
        books.push({
          id: e.getAttribute("value"),
          title: "",
          due: "",
          status: "",
        });
      },
    })
    .on(`h2.card-title`, {
      text(text: Text) {
        if (!text.lastInTextNode) {
          books[books.length - 1].title = text.text;
        }
      },
    })
    .on("td[data-caption='Due']", {
      text(text: Text) {
        if (!text.lastInTextNode) {
          if (!books[books.length - 1].due) {
            books[books.length - 1].due = text.text;
          } else {
            books[books.length - 1].due = `${books[books.length - 1].due}${
              text.text
            }`;
          }
        }
      },
    })
    .on("td[data-caption='Status']", {
      text(text: Text) {
        if (!text.lastInTextNode) {
          if (!books[books.length - 1].status) {
            books[books.length - 1].status = text.text;
          } else {
            books[books.length - 1].status = `${
              books[books.length - 1].status
            }${text.text}`;
          }
        }
      },
    })
    .transform(spydusResponse);

  await rewriter.text();

  return books;
}
