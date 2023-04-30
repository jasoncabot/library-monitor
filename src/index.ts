import { parseString } from "set-cookie-parser";

export interface Env {
  BORROWER_ID: string;
  BORROWER_PASSWORD: string;
}

interface Book {
  title: string;
  due: string;
  status: string;
}

const checkForOverdueBooks = async (
  alwaysSend: boolean,
  borrowerId: string,
  password: string
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
    let dashResponse = await (
      await fetch(dashLink, {
        headers: { cookie: `SPYDUS_BRWSESSIONID_443=${value}` },
      })
    ).text();

    const loansPath = (new RegExp(
      /"(\/cgi-bin\/spydus.exe\/ENQ\/WPAC\/LOANRENQ[^"]+QRY=OND01[^"]+)"/
    ).exec(dashResponse) || ["", ""])[1]
      .replaceAll("&amp;", "&")
      .replaceAll("&lt;", "%3C")
      .replaceAll("&gt;", "%3E");
    const loansURL = "https://wokingham.spydus.co.uk" + loansPath;

    console.log("Finding all loans from " + loansURL);
    const spydusResponse = await fetch(loansURL, {
      headers: { cookie: `SPYDUS_BRWSESSIONID_443=${value}` },
    });

    const books: any[] = [];
    const rewriter = new HTMLRewriter()
      .on(`input[name=SVL]`, {
        element(e: Element) {
          books.push({ id: e.getAttribute("value") });
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
            books[books.length - 1].due = text.text;
          }
        },
      })
      .on("td[data-caption='Status']", {
        text(text: Text) {
          if (!text.lastInTextNode) {
            books[books.length - 1].status = text.text;
          }
        },
      })
      .transform(spydusResponse);

    await rewriter.text();
    console.log(`Found ${books.length} book(s), checking for overdue...`);

    // find any books past or nearing renewal date
    const now = new Date();
    const overdue = books.filter((book) => {
      const dueAt = Date.parse(book.due);
      let difference = dueAt - now.getTime();
      return alwaysSend || difference < 172800000;
    }) as Book[];

    console.log(`Found ${overdue.length} books out of ${books.length}`);

    // 2. If any are overdue
    if (overdue.length > 0) {
      const text = overdue
        .map(
          (book) =>
            `* ${book.title} is due ${book.due} and has status: ${book.status}.`
        )
        .join("\n");

      const sendEmail = new Request("https://api.mailchannels.net/tx/v1/send", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          personalizations: [
            {
              to: [
                { email: "jasoncabot@gmail.com" },
                { email: "kirstycabot@gmail.com" },
              ],
            },
          ],
          from: {
            email: "library-monitor@jasoncabot.com",
            name: "Library Monitor",
          },
          subject: `${books.length} books near renewal date`,
          content: [
            {
              type: "text/plain",
              value: text,
            },
          ],
        }),
      });

      let resp = await fetch(sendEmail);
      let respText = await resp.text();
      console.log(text);
      console.log("sent email and got " + respText);
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
      env.BORROWER_PASSWORD
    );
    return new Response(response, { status: 200 });
  },

  async scheduled(
    controller: ScheduledController,
    env: Env,
    ctx: ExecutionContext
  ): Promise<void> {
    await checkForOverdueBooks(false, env.BORROWER_ID, env.BORROWER_PASSWORD);
  },
};
